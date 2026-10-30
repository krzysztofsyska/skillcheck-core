/**
 * Version discovery occurs under the dedicated DB screening_worker role.
 * Never attempt the other lease RPC as a fallback: claiming mutates state.
 */
export function screeningClaimRpcName(resultSchemaVersion: number): 'claim_screening_attempt' | 'claim_screening_attempt_v2' {
  if (resultSchemaVersion === 1) return 'claim_screening_attempt';
  if (resultSchemaVersion === 2) return 'claim_screening_attempt_v2';
  throw new Error('Unsupported evidence schema version.');
}
