import type { AiTask } from './core.ts';
import { AI_TASKS } from './core.ts';

export type AiLedgerReportRow = {
  companyId: string;
  billingMonth: string; // yyyy-mm, UTC
  task: AiTask;
  processId: string | null;
  candidatePseudonym: string | null;
  status: 'reserved' | 'settled' | 'unknown' | 'released';
  reservedMicroUsd: number;
  actualMicroUsd: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};
export type CostBucket = {
  settledMicroUsd: number;
  unconfirmedMicroUsd: number;
  attempts: number;
  unknownAttempts: number;
  // null means at least one settled operation lacked provider token usage.
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};
export type CostReport = {
  companyId: string;
  billingMonth: string;
  total: CostBucket;
  byTask: Record<string, CostBucket>;
  byProcess: Record<string, CostBucket>;
  byCandidate: Record<string, CostBucket>;
};

function empty(): CostBucket {
  return {
    settledMicroUsd: 0, unconfirmedMicroUsd: 0,
    attempts: 0, unknownAttempts: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
  };
}
function safeNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function addSafe(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new Error('SC021_REPORT_OVERFLOW');
  return value;
}
function bucket(map: Record<string, CostBucket>, key: string): CostBucket {
  if (!Object.hasOwn(map, key)) map[key] = empty();
  return map[key];
}
function add(b: CostBucket, row: AiLedgerReportRow) {
  b.attempts = addSafe(b.attempts, 1);
  if (row.status === 'settled') {
    b.settledMicroUsd = addSafe(b.settledMicroUsd, row.actualMicroUsd as number);
    for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const) {
      if (row[field] === null) b[field] = null;
      else if (b[field] !== null) b[field] = addSafe(b[field], row[field]);
    }
  } else if (row.status === 'unknown' || row.status === 'reserved') {
    b.unconfirmedMicroUsd = addSafe(b.unconfirmedMicroUsd, row.reservedMicroUsd);
    if (row.status === 'unknown') b.unknownAttempts = addSafe(b.unknownAttempts, 1);
  }
}

export function summarizeAiCosts(
  companyId: string, billingMonth: string, rows: readonly AiLedgerReportRow[],
): CostReport {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(companyId)
    || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(billingMonth)) {
    throw new Error('SC021_INVALID_REPORT_SCOPE');
  }
  const report: CostReport = {
    companyId, billingMonth, total: empty(),
    byTask: Object.create(null), byProcess: Object.create(null),
    byCandidate: Object.create(null),
  };
  for (const row of rows) {
    // Reject cross-tenant rows rather than silently hiding an upstream authorization defect.
    if (row.companyId !== companyId || row.billingMonth !== billingMonth) {
      throw new Error('SC021_REPORT_SCOPE_MISMATCH');
    }
    if (!AI_TASKS.includes(row.task)
      || !['reserved','settled','unknown','released'].includes(row.status)
      || !safeNum(row.reservedMicroUsd)
      || (row.actualMicroUsd !== null && !safeNum(row.actualMicroUsd))
      || (row.status === 'settled' && row.actualMicroUsd === null)
      || (row.status !== 'settled' && row.actualMicroUsd !== null)
      || ![row.inputTokens, row.cachedInputTokens, row.outputTokens].every(v => v === null || safeNum(v))
      || (row.cachedInputTokens !== null && row.inputTokens !== null
        && row.cachedInputTokens > row.inputTokens)
      || (row.processId !== null && !/^[0-9a-f-]{36}$/i.test(row.processId))
      || (row.candidatePseudonym !== null
        && !/^[A-Za-z0-9:_-]{1,80}$/.test(row.candidatePseudonym))) {
      throw new Error('SC021_INVALID_REPORT_ROW');
    }
    add(report.total, row);
    add(bucket(report.byTask, row.task), row);
    add(bucket(report.byProcess, row.processId ?? 'unassigned'), row);
    add(bucket(report.byCandidate, row.candidatePseudonym ?? '\u0000no-candidate'), row);
  }
  return report;
}
