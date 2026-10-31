export const humanDecisions = [
  ['next_stage', 'Kolejny etap'],
  ['on_hold', 'Wstrzymany'],
  ['closed', 'Zakończony'],
] as const;
export type HumanDecision = typeof humanDecisions[number][0];

export function parseHumanDecision(decision: unknown, justification: unknown) {
  if (typeof decision !== 'string' || !humanDecisions.some(([value]) => value === decision)) {
    throw new Error('Wybierz decyzję ręcznie.');
  }
  if (typeof justification !== 'string') throw new Error('Wpisz uzasadnienie decyzji.');
  const reason = justification.trim();
  if (reason.length < 10 || reason.length > 5000) {
    throw new Error('Uzasadnienie musi mieć od 10 do 5000 znaków.');
  }
  return { decision: decision as HumanDecision, reason };
}

export function parseInterviewNote(value: unknown) {
  if (typeof value !== 'string') throw new Error('Wpisz notatkę tekstową.');
  if (value.length > 10000) throw new Error('Skróć notatkę do 10 000 znaków.');
  return value.trim() || null;
}

export function parseStageDirection(value: unknown): -1 | 1 {
  if (value !== -1 && value !== 1) throw new Error('Wybierz przesunięcie o jedną pozycję.');
  return value;
}
