import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

export const ArtifactReceiptSchema = z.object({
  uri: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  producer: z.string().min(1),
}).strict();

export type ArtifactReceipt = z.infer<typeof ArtifactReceiptSchema>;

export interface ImmutableArtifactStore {
  put(input: {
    uri: string;
    content: Uint8Array;
    mediaType: string;
    producer: string;
  }): Promise<ArtifactReceipt>;
  get(uri: string): Promise<Uint8Array>;
}

export class InMemoryArtifactStore implements ImmutableArtifactStore {
  private readonly records = new Map<string, { receipt: ArtifactReceipt; content: Uint8Array }>();

  async put(input: {
    uri: string;
    content: Uint8Array;
    mediaType: string;
    producer: string;
  }): Promise<ArtifactReceipt> {
    const content = new Uint8Array(input.content);
    const receipt = ArtifactReceiptSchema.parse({
      uri: input.uri,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
      mediaType: input.mediaType,
      producer: input.producer,
    });
    const existing = this.records.get(receipt.uri);
    if (existing) {
      if (
        existing.receipt.sha256 !== receipt.sha256 ||
        existing.receipt.bytes !== receipt.bytes ||
        existing.receipt.mediaType !== receipt.mediaType ||
        existing.receipt.producer !== receipt.producer
      ) {
        throw new Error(`immutable artifact URI collision: ${receipt.uri}`);
      }
      return existing.receipt;
    }
    this.records.set(receipt.uri, { receipt, content });
    return receipt;
  }

  async get(uri: string): Promise<Uint8Array> {
    const record = this.records.get(uri);
    if (!record) throw new Error(`artifact가 없다: ${uri}`);
    return new Uint8Array(record.content);
  }
}

export class FileSystemArtifactStore implements ImmutableArtifactStore {
  constructor(private readonly root: string) {
    this.root = resolve(root);
  }

  async put(input: {
    uri: string;
    content: Uint8Array;
    mediaType: string;
    producer: string;
  }): Promise<ArtifactReceipt> {
    const content = new Uint8Array(input.content);
    const receipt = ArtifactReceiptSchema.parse({
      uri: input.uri,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
      mediaType: input.mediaType,
      producer: input.producer,
    });
    const path = this.pathFor(receipt.uri);
    const receiptPath = `${path}.receipt.json`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      try {
        await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        const stored = await readFile(path);
        if (!stored.equals(Buffer.from(content))) throw error;
        throw error;
      }
      return receipt;
    } catch (error) {
      const existing = await this.readReceipt(receiptPath).catch(() => undefined);
      const stored = await readFile(path).catch(() => undefined);
      if (stored?.equals(Buffer.from(content)) && !existing) {
        await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 })
          .catch(() => undefined);
        const recovered = await this.readReceipt(receiptPath).catch(() => undefined);
        if (recovered
          && recovered.sha256 === receipt.sha256
          && recovered.bytes === receipt.bytes
          && recovered.mediaType === receipt.mediaType
          && recovered.producer === receipt.producer) return recovered;
      }
      if (!existing || !stored
        || existing.sha256 !== receipt.sha256
        || existing.bytes !== receipt.bytes
        || existing.mediaType !== receipt.mediaType
        || existing.producer !== receipt.producer
        || !stored.equals(Buffer.from(content))) {
        throw new Error(`immutable artifact URI collision: ${receipt.uri}`, { cause: error });
      }
      return existing;
    }
  }

  async get(uri: string): Promise<Uint8Array> {
    const path = this.pathFor(uri);
    const content = await readFile(path).catch(() => undefined);
    if (!content) throw new Error(`artifact가 없다: ${uri}`);
    const receipt = await this.readReceipt(`${path}.receipt.json`);
    const observed = createHash('sha256').update(content).digest('hex');
    if (observed !== receipt.sha256 || content.byteLength !== receipt.bytes) {
      throw new Error(`artifact receipt와 content가 다르다: ${uri}`);
    }
    return new Uint8Array(content);
  }

  private pathFor(uri: string): string {
    if (uri.includes('%')) throw new Error(`artifact URI가 안전하지 않다: ${uri}`);
    const parsed = new URL(uri);
    if (parsed.protocol !== 'artifact:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
      throw new Error(`artifact URI가 안전하지 않다: ${uri}`);
    }
    const segments = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)].map((value) =>
      decodeURIComponent(value),
    );
    if (segments.length < 2 || segments.some((value) => !/^[A-Za-z0-9._-]+$/.test(value))) {
      throw new Error(`artifact URI segment가 안전하지 않다: ${uri}`);
    }
    const path = resolve(this.root, ...segments);
    const escaped = relative(this.root, path);
    if (escaped === '..' || escaped.startsWith(`..${sep}`)) throw new Error(`artifact URI가 root 밖이다: ${uri}`);
    return path;
  }

  private async readReceipt(path: string): Promise<ArtifactReceipt> {
    return ArtifactReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  }
}
