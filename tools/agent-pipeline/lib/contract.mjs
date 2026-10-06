import { sha256 } from './canonical.mjs';

const FIELD = /^([A-Z][A-Z0-9_]*):[ \t]*(.*)$/;

export function parseContract(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const fields = {};
  const lists = {};
  let listKey = null;
  for (const line of lines) {
    if (listKey && /^\s*-[ \t]+/.test(line)) {
      lists[listKey].push(line.replace(/^\s*-[ \t]+/, '').trim());
      continue;
    }
    listKey = null;
    const match = FIELD.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      lists[key] = [];
      listKey = key;
      continue;
    }
    fields[key] = value;
  }
  const allowed = lists.ALLOWED_FILES ?? [];
  const tests = lists.REQUIRED_TESTS ?? [];
  const taskId = fields.TASK ?? null;
  const normalized = {
    task_id: taskId,
    level: fields.LEVEL ?? null,
    scope: fields.SCOPE ?? null,
    status: fields.STATUS ?? null,
    owner: fields.OWNER ?? null,
    reviewer: fields.REVIEWER ?? null,
    depends_on: fields.DEPENDS_ON ?? fields.DEPENDS ?? null,
    slug: fields.BRANCH_SLUG ?? null,
    allowed_files: allowed,
    required_tests: tests,
    acceptance_criteria: lists.ACCEPTANCE_CRITERIA ?? [],
    security_checks: lists.SECURITY_CHECKS ?? [],
    // Preserve prose and every field, not just the parser's known metadata.
    source: String(body ?? '').replace(/\r\n/g, '\n').trim(),
  };
  return {
    ...normalized,
    hash: sha256(normalized),
    ready: normalized.status === 'READY' && /^SC-[A-Z0-9-]+$/.test(taskId ?? '')
      && ['L1', 'L2', 'L3'].includes(normalized.level)
      && ['FRONTEND', 'BACKEND', 'FULLSTACK', 'OPERATIONS'].includes(normalized.scope)
      && normalized.owner === 'Cursor' && normalized.reviewer === 'Codex'
      && allowed.length > 0 && tests.length > 0
      && normalized.acceptance_criteria.length > 0 && normalized.security_checks.length > 0
      && normalized.depends_on != null,
  };
}

export function branchName(contract) {
  const slug = String(contract.slug || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'task';
  return `feat/${String(contract.task_id).toLowerCase()}-${slug}`;
}

export function contractChanged(record, body) {
  if (!record?.contract_hash) return false;
  return parseContract(body).hash !== record.contract_hash;
}
