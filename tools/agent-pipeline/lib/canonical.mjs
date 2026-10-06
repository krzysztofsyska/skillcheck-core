import { createHash } from 'node:crypto';

const UUID_NAMESPACE = '6ba7b8119dad11d180b400c04fd430c8';

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      const item = value[key];
      if (item !== undefined) acc[key] = sortValue(item);
      return acc;
    }, {});
  }
  return value;
}

export function sha256(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(text).digest('hex');
}

export function uuidV5(name, namespaceHex = UUID_NAMESPACE) {
  const hash = createHash('sha1')
    .update(Buffer.from(namespaceHex, 'hex'))
    .update(String(name))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function agentIdFor(operationKey) {
  return `bc-${uuidV5(operationKey)}`;
}

export function operationKey({ repositoryId, taskId, taskRevision, headSha, baseSha, action, round }) {
  return [repositoryId, taskId, taskRevision, headSha ?? '-', baseSha ?? '-', action, round ?? 0].join('/');
}

export function notificationId({ taskId, stateRevision, recipient, kind }) {
  return sha256(`${taskId}/${stateRevision}/${recipient}/${kind}`);
}
