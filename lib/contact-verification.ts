/** Server-only trust boundary. No route, provider, dispatch or browser export.
 * The signature domain asserts BOTH verified contact control and permission under
 * the specified notice. Trusted context/config must be loaded server-side, never
 * forwarded from request JSON. SQL executor must use contact_verifier only.
 */
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export const RECEIPT_DOMAIN = 'SC010B2_CANDIDATE_CONTACT_AND_PERMISSION_VERIFIED_V1\0';
const SQL = 'select private.ingest_verified_contact_receipt($1::jsonb, $2::jsonb) as receipt_id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const revisions = ['global_permission_revision', 'scoped_permission_revision', 'preference_revision', 'expected_contact_version'] as const;
export type VerificationContext = {
  company_id: string; candidate_id: string; recruitment_id: string;
  channel: 'email' | 'sms' | 'voice'; purpose: 'verification_invitation';
  notice_version: string; policy_version: string; template_version: string;
  global_permission_revision: number; scoped_permission_revision: number;
  preference_revision: number; expected_contact_version: number;
  destination: string;
};
export type SignedContactReceipt = VerificationContext & {
  proof_type: 'candidate_contact_and_permission_verified_v1'; receipt_id: string; issuer_id: string; key_id: string; nonce: string;
  issued_at: string; expires_at: string;
};
export type VerificationConfig = {
  issuers: readonly { issuer_id: string; key_id: string; company_id: string; publicKeyPem: string }[];
  encryptionKey: Uint8Array; encryptionKeyId: string; fingerprintKey: Uint8Array;
};
export type ContactEnvelope = { algorithm: 'A256GCM'; key_id: string; iv: string; ciphertext: string; tag: string };
export type VerificationExecutor = (sql: string, parameters: readonly [string, string]) => Promise<unknown>;
const fields = ['company_id','candidate_id','recruitment_id','channel','purpose','notice_version','policy_version','template_version',...revisions,'destination','proof_type','receipt_id','issuer_id','key_id','nonce','issued_at','expires_at'].sort();
function denied(): never { throw new Error('CONTACT_VERIFICATION_REJECTED'); }
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
function decode(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > limit) denied();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) denied();
  return bytes;
}
function destinationValid(channel: string, destination: unknown): destination is string {
  if (typeof destination !== 'string') return false;
  // Require exact normalization by the verifier, never silently rewrite an attestation.
  if (channel === 'email') return destination.length <= 254 && destination === destination.toLowerCase() && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(destination);
  return (channel === 'sms' || channel === 'voice') && /^\+[1-9][0-9]{7,14}$/.test(destination);
}
function validateConfig(config: VerificationConfig) {
  if (typeof window !== 'undefined' || !config || !(config.encryptionKey instanceof Uint8Array) || !(config.fingerprintKey instanceof Uint8Array)
    || config.encryptionKey.length !== 32 || config.fingerprintKey.length !== 32 || timingSafeEqual(config.encryptionKey, config.fingerprintKey)
    || !ID.test(config.encryptionKeyId) || !Array.isArray(config.issuers)) denied();
}
function aad(context: VerificationContext): Buffer {
  return Buffer.from(JSON.stringify(['SC010B2_CONTACT_V1', context.company_id, context.candidate_id, context.channel, context.expected_contact_version + 1]));
}
/** No I/O until all cryptographic and contextual checks pass. Database rechecks
 * revisions/expiry/replay under locks. Returns only its opaque result. */
export async function ingestContactVerification(input: {
  attestation: { payload: string; signature: string }; context: VerificationContext;
  config: VerificationConfig; execute: VerificationExecutor; now?: Date;
}): Promise<unknown> {
  let receipt: Record<string, unknown>; let envelope: ContactEnvelope;
  try {
    const { config, context, attestation } = input;
    validateConfig(config);
    if (!exactObject(attestation, ['payload','signature'])) denied();
    const bytes = decode(attestation.payload, 12000), signature = decode(attestation.signature, 100);
    if (signature.length !== 64) denied();
    // JSON canonical serialization rejects duplicate keys, whitespace ambiguity and
    // lossy UTF-8 decoding while the actual signature is over the original bytes.
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!exactObject(parsed, fields) || JSON.stringify(parsed) !== bytes.toString('utf8')) denied();
    for (const key of ['company_id','candidate_id','recruitment_id','receipt_id','nonce']) if (typeof parsed[key] !== 'string' || !UUID.test(parsed[key] as string)) denied();
    for (const key of ['issuer_id','key_id','notice_version','policy_version','template_version']) if (typeof parsed[key] !== 'string' || !ID.test(parsed[key] as string)) denied();
    for (const key of revisions) if (!Number.isSafeInteger(parsed[key]) || (parsed[key] as number) < 0 || (parsed[key] as number) >= Number.MAX_SAFE_INTEGER) denied();
    if (parsed.proof_type !== 'candidate_contact_and_permission_verified_v1' || parsed.purpose !== 'verification_invitation' || !destinationValid(parsed.channel as string, parsed.destination)) denied();
    const contextKeys = ['company_id','candidate_id','recruitment_id','channel','purpose','notice_version','policy_version','template_version',...revisions,'destination'] as const;
    for (const key of contextKeys) if (parsed[key] !== context[key]) denied();
    const issuer = config.issuers.find(item => item.issuer_id === parsed.issuer_id && item.key_id === parsed.key_id && item.company_id === parsed.company_id);
    if (!issuer) denied();
    const key = createPublicKey(issuer.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.concat([Buffer.from(RECEIPT_DOMAIN), bytes]), key, signature)) denied();
    const now = (input.now ?? new Date()).getTime();
    const issued = Date.parse(String(parsed.issued_at)), expiry = Date.parse(String(parsed.expires_at));
    for (const field of ['issued_at','expires_at']) if (typeof parsed[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[field] as string) || new Date(parsed[field] as string).toISOString() !== parsed[field]) denied();
    if (!Number.isFinite(now) || issued > now || expiry <= now || expiry <= issued || expiry - issued > 15 * 60 * 1000) denied();
    const contact_digest = createHmac('sha256', config.fingerprintKey).update(JSON.stringify(['SC010B2_CONTACT_DIGEST_V1', context.company_id, context.candidate_id, context.channel, context.destination])).digest('hex');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(context.destination, 'utf8'), cipher.final()]);
    envelope = { algorithm: 'A256GCM', key_id: config.encryptionKeyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    const { destination: _privateDestination, ...safe } = parsed;
    receipt = { ...safe, contact_digest };
  } catch { denied(); }
  try { return await input.execute(SQL, [JSON.stringify(receipt), JSON.stringify(envelope)]); }
  catch { throw new Error('CONTACT_VERIFICATION_NOT_ACCEPTED'); }
}
/** Internal vault primitive, not exposed via any RPC or route. Caller must perform
 * its own authorization. AAD binds the tenant/candidate/channel/contact generation. */
export function decryptContactEnvelope(envelope: ContactEnvelope, context: VerificationContext, config: VerificationConfig): string {
  try {
    validateConfig(config);
    if (!exactObject(envelope, ['algorithm','key_id','iv','ciphertext','tag']) || envelope.algorithm !== 'A256GCM' || envelope.key_id !== config.encryptionKeyId) denied();
    const iv = decode(envelope.iv, 20), tag = decode(envelope.tag, 24), encrypted = decode(envelope.ciphertext, 400);
    if (iv.length !== 12 || tag.length !== 16) denied();
    const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
    decipher.setAAD(aad(context)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { denied(); }
}
