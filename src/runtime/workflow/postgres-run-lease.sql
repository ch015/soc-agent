CREATE TABLE IF NOT EXISTS nunchi_run_leases (
  run_id text PRIMARY KEY,
  owner_id text NOT NULL,
  token uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS nunchi_run_leases_expiry_idx
  ON nunchi_run_leases (expires_at);
