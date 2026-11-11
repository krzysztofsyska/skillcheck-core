// SC-014/SC-016: verify the response-side company and parent UUID links,
// not only the PostgREST filters. The same RLS user still performs the reads.
export const exerciseUuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sameUuid = (actual: unknown, expected: string): boolean =>
  typeof actual === 'string' && typeof expected === 'string'
  && exerciseUuid.test(actual) && exerciseUuid.test(expected)
  && actual.toLowerCase() === expected.toLowerCase();

/** The recruitment response must belong to this route and point to a valid position. */
export function exerciseRecruitmentMatches(value: unknown, companyId: string, recruitmentId: string): boolean {
  if (!record(value)) return false;
  return sameUuid(value.id, recruitmentId)
    && sameUuid(value.company_id, companyId)
    && typeof value.position_id === 'string' && exerciseUuid.test(value.position_id);
}

/** Never consume a position from another company, even on a malformed API response. */
export function exercisePositionMatches(value: unknown, companyId: string, positionId: string): boolean {
  if (!record(value)) return false;
  return sameUuid(value.id, positionId) && sameUuid(value.company_id, companyId);
}
