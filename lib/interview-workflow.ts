import type { EvidenceItem, EvidenceAnalysis, HumanCandidateDecision } from './supabase/database.types';

/** Only an explicitly accepted/edited human review can seed a question.
 * The model's verdict alone is never enough. No candidate decision is inferred.
 */
export function reviewedGaps(items: EvidenceItem[], requirements: EvidenceAnalysis['requirements_snapshot']) {
  const byKey = new Map(requirements.map((r, index) => [r.id, { requirement: r, index }]));
  return items.flatMap(item => {
    if (item.human_status !== 'accepted' && item.human_status !== 'edited') return [];
    const verdict = item.human_status === 'edited' ? item.human_verdict : item.verdict;
    if (!['partial', 'missing', 'contradicted'].includes(verdict ?? '')) return [];
    const source = byKey.get(item.requirement_key);
    if (!source) return [];
    const suggestion = item.human_status === 'edited' ? item.human_question : item.suggested_question;
    const question = suggestion?.trim() || `Podaj przykład zawodowy dotyczący: ${source.requirement.text}`;
    return [{
      itemId: item.id, requirementKey: item.requirement_key,
      requirementText: source.requirement.text,
      questionText: question.slice(0, 2000), index: source.index,
    }];
  }).sort((a, b) => a.index - b.index);
}

export const decisionLabels: Record<HumanCandidateDecision['decision'], string> = {
  next_stage: 'Kolejny etap', on_hold: 'Wstrzymany', completed: 'Zakończony',
};

/** Called exclusively from the authenticated human-operated HTTP action. */
export function parseHumanDecision(value: unknown, reason: unknown): {
  decision: HumanCandidateDecision['decision']; justification: string;
} {
  if (value !== 'next_stage' && value !== 'on_hold' && value !== 'completed') {
    throw new Error('Wybierz decyzję ręcznie.');
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 10000) {
    throw new Error('Uzasadnienie decyzji jest wymagane (do 10 000 znaków).');
  }
  return { decision: value, justification: reason.trim() };
}
