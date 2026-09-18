import {
  createHash,
  sign,
  timingSafeEqual,
  verify,
  type KeyLike,
} from 'node:crypto';

import {
  SocPreparedSnapshotUnsignedSchema,
  SocRedactionReceiptSchema,
  type SocPreparedSnapshotUnsigned,
  type SocRedactionReceipt,
} from './contracts/soc-schemas.js';

export interface SocRedactionTrustStore {
  resolve(issuer: string, keyId: string): KeyLike | undefined;
}

export type SocRedactionReceiptMetadata = Omit<
  SocRedactionReceipt,
  'projectionSha256' | 'signatureBase64'
>;

export function signSocRedactionReceipt(
  snapshot: Omit<SocPreparedSnapshotUnsigned, 'redactionReceipt'>,
  metadata: SocRedactionReceiptMetadata,
  privateKey: KeyLike,
): SocRedactionReceipt {
  const projectionSha256 = projectionHash(snapshot);
  const unsignedReceipt = SocRedactionReceiptSchema.omit({ signatureBase64: true }).parse({
    ...metadata,
    projectionSha256,
  });
  const signatureBase64 = sign(null, receiptBytes(unsignedReceipt), privateKey).toString('base64');
  return SocRedactionReceiptSchema.parse({ ...unsignedReceipt, signatureBase64 });
}

export function verifySocRedactionAttestation(
  snapshotInput: SocPreparedSnapshotUnsigned,
  trust: SocRedactionTrustStore,
): SocRedactionReceipt {
  const snapshot = SocPreparedSnapshotUnsignedSchema.parse(snapshotInput);
  const { redactionReceipt: receipt, ...projection } = snapshot;
  const observedProjectionHash = projectionHash(projection);
  const expectedHash = Buffer.from(receipt.projectionSha256, 'hex');
  const observedHash = Buffer.from(observedProjectionHash, 'hex');
  if (!timingSafeEqual(expectedHash, observedHash)) {
    throw new Error('SOC redaction attestation projection hash가 다르다');
  }
  const key = trust.resolve(receipt.issuer, receipt.keyId);
  if (!key) throw new Error(`SOC redaction attestation signer를 신뢰하지 않는다: ${receipt.issuer}/${receipt.keyId}`);
  const { signatureBase64, ...unsignedReceipt } = receipt;
  const valid = verify(
    null,
    receiptBytes(unsignedReceipt),
    key,
    Buffer.from(signatureBase64, 'base64'),
  );
  if (!valid) throw new Error('SOC redaction attestation signature가 유효하지 않다');
  return receipt;
}

function projectionHash(value: unknown): string {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
}

function receiptBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}
