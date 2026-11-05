type Scope = {companyId:string; recruitmentId:string; applicationId:string};
export function staffWorkSample(value:unknown, scope:Scope, attemptId:string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Brak odpowiedzi.');
  const row = value as Record<string,unknown>;
  if (row.companyId !== scope.companyId || row.recruitmentId !== scope.recruitmentId ||
      row.applicationId !== scope.applicationId || row.attemptId !== attemptId ||
      typeof row.workSample !== 'string') throw new Error('Niezgodne powiązanie odpowiedzi.');
  return row.workSample;
}
