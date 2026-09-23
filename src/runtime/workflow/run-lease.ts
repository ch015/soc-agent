import { randomUUID } from 'node:crypto';

export type RunLease = {
  runId: string;
  ownerId: string;
  token: string;
  fencingToken: number;
  expiresAt: string;
};

export interface RunLeaseBackend {
  acquire(input: { runId: string; ownerId: string; ttlMs: number }): Promise<RunLease>;
  renew(lease: RunLease, ttlMs: number): Promise<RunLease>;
  assertActive(lease: RunLease): Promise<void>;
  release(lease: RunLease): Promise<void>;
}

export class AutoRenewingRunLease {
  private timer?: ReturnType<typeof setTimeout>;
  private renewal?: Promise<void>;
  private renewalError?: unknown;
  private stopped = false;

  private constructor(
    private readonly backend: RunLeaseBackend,
    private active: RunLease,
    private readonly ttlMs: number,
  ) {
    this.schedule();
  }

  static async acquire(
    backend: RunLeaseBackend,
    input: { runId: string; ownerId: string; ttlMs: number },
  ): Promise<AutoRenewingRunLease> {
    const lease = await backend.acquire(input);
    return new AutoRenewingRunLease(backend, lease, input.ttlMs);
  }

  async assertActive(): Promise<void> {
    await this.renewal;
    if (this.renewalError !== undefined) throw this.renewalError;
    await this.backend.assertActive(this.active);
  }

  fencingToken(): number {
    return this.active.fencingToken;
  }

  async release(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.renewal?.catch(() => undefined);
    await this.backend.release(this.active);
  }

  private schedule(): void {
    if (this.stopped || this.renewalError !== undefined) return;
    this.timer = setTimeout(() => {
      this.renewal = this.backend.renew(this.active, this.ttlMs)
        .then((renewed) => { this.active = renewed; })
        .catch((error: unknown) => { this.renewalError = error; })
        .finally(() => {
          this.renewal = undefined;
          this.schedule();
        });
    }, Math.max(250, Math.floor(this.ttlMs / 3)));
    this.timer.unref?.();
  }
}

export class InMemoryRunLeaseBackend implements RunLeaseBackend {
  private readonly leases = new Map<string, RunLease>();
  private readonly fences = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(input: { runId: string; ownerId: string; ttlMs: number }): Promise<RunLease> {
    assertTtl(input.ttlMs);
    const existing = this.leases.get(input.runId);
    if (existing && Date.parse(existing.expiresAt) > this.now()) {
      throw new Error(`run lease가 이미 사용 중이다: ${input.runId}`);
    }
    const fencingToken = (this.fences.get(input.runId) ?? 0) + 1;
    this.fences.set(input.runId, fencingToken);
    const lease = {
      runId: input.runId,
      ownerId: input.ownerId,
      token: randomUUID(),
      fencingToken,
      expiresAt: new Date(this.now() + input.ttlMs).toISOString(),
    };
    this.leases.set(input.runId, lease);
    return { ...lease };
  }

  async renew(lease: RunLease, ttlMs: number): Promise<RunLease> {
    assertTtl(ttlMs);
    await this.assertActive(lease);
    const renewed = { ...lease, expiresAt: new Date(this.now() + ttlMs).toISOString() };
    this.leases.set(lease.runId, renewed);
    return { ...renewed };
  }

  async assertActive(lease: RunLease): Promise<void> {
    const active = this.leases.get(lease.runId);
    if (!active
      || active.token !== lease.token
      || active.fencingToken !== lease.fencingToken
      || Date.parse(active.expiresAt) <= this.now()) {
      throw new Error(`run lease가 만료되었거나 fencing token이 다르다: ${lease.runId}`);
    }
  }

  async release(lease: RunLease): Promise<void> {
    const active = this.leases.get(lease.runId);
    if (active?.token === lease.token && active.fencingToken === lease.fencingToken) {
      this.leases.delete(lease.runId);
    }
  }
}

export type SqlQueryResult<Row = Record<string, unknown>> = { rows: Row[]; rowCount?: number | null };
export interface SqlConnection {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  release(): void;
}
export interface SqlPool {
  connect(): Promise<SqlConnection>;
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}

type LeaseRow = { run_id: string; owner_id: string; token: string; fencing_token: string | number; expires_at: string | Date };

export class PostgresRunLeaseBackend implements RunLeaseBackend {
  constructor(private readonly pool: SqlPool) {}

  async acquire(input: { runId: string; ownerId: string; ttlMs: number }): Promise<RunLease> {
    assertTtl(input.ttlMs);
    const connection = await this.pool.connect();
    const token = randomUUID();
    try {
      await connection.query('BEGIN');
      const result = await connection.query<LeaseRow>(`
        INSERT INTO nunchi_run_leases (run_id, owner_id, token, fencing_token, expires_at)
        VALUES ($1, $2, $3, 1, clock_timestamp() + ($4 * interval '1 millisecond'))
        ON CONFLICT (run_id) DO UPDATE
          SET owner_id = EXCLUDED.owner_id,
              token = EXCLUDED.token,
              fencing_token = nunchi_run_leases.fencing_token + 1,
              expires_at = EXCLUDED.expires_at
          WHERE nunchi_run_leases.expires_at <= clock_timestamp()
        RETURNING run_id, owner_id, token, fencing_token, expires_at
      `, [input.runId, input.ownerId, token, input.ttlMs]);
      const row = result.rows[0];
      if (!row) throw new Error(`run lease가 이미 사용 중이다: ${input.runId}`);
      await connection.query('COMMIT');
      return rowToLease(row);
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async renew(lease: RunLease, ttlMs: number): Promise<RunLease> {
    assertTtl(ttlMs);
    const result = await this.pool.query<LeaseRow>(`
      UPDATE nunchi_run_leases
      SET expires_at = clock_timestamp() + ($4 * interval '1 millisecond')
      WHERE run_id = $1 AND token = $2 AND fencing_token = $3 AND expires_at > clock_timestamp()
      RETURNING run_id, owner_id, token, fencing_token, expires_at
    `, [lease.runId, lease.token, lease.fencingToken, ttlMs]);
    const row = result.rows[0];
    if (!row) throw new Error(`run lease 갱신이 거부됐다: ${lease.runId}`);
    return rowToLease(row);
  }

  async assertActive(lease: RunLease): Promise<void> {
    const result = await this.pool.query<{ active: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM nunchi_run_leases
        WHERE run_id = $1 AND token = $2 AND fencing_token = $3 AND expires_at > clock_timestamp()
      ) AS active
    `, [lease.runId, lease.token, lease.fencingToken]);
    if (result.rows[0]?.active !== true) {
      throw new Error(`run lease가 만료되었거나 fencing token이 다르다: ${lease.runId}`);
    }
  }

  async release(lease: RunLease): Promise<void> {
    await this.pool.query(
      `UPDATE nunchi_run_leases
       SET expires_at = clock_timestamp()
       WHERE run_id = $1 AND token = $2 AND fencing_token = $3`,
      [lease.runId, lease.token, lease.fencingToken],
    );
  }
}

function rowToLease(row: LeaseRow): RunLease {
  return {
    runId: row.run_id,
    ownerId: row.owner_id,
    token: row.token,
    fencingToken: Number(row.fencing_token),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
    throw new Error(`run lease TTL이 허용 범위가 아니다: ${ttlMs}`);
  }
}
