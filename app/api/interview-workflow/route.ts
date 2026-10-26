import { NextResponse } from 'next/server';
import { companyAccess } from '../../../lib/company-access';
import { isUuid } from '../../../lib/screening-ui';
import { parseHumanDecision, reviewedGaps } from '../../../lib/interview-workflow';

export const runtime = 'nodejs';
type Input = Record<string, unknown>;
const invalid = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
const validText = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const trimmed = (value: unknown) => String(value).trim();

export async function POST(request: Request) {
  let input: Input;
  try { input = await request.json(); }
  catch { return invalid('Nieprawidłowe dane.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !isUuid(input.companyId) || !isUuid(input.recruitmentId) || !isUuid(input.applicationId)) {
    return invalid('Nieprawidłowe identyfikatory.');
  }
  const companyId = String(input.companyId), recruitmentId = String(input.recruitmentId);
  const applicationId = String(input.applicationId);
  const action = input.action;
  let access: Awaited<ReturnType<typeof companyAccess>>;
  try { access = await companyAccess(companyId); }
  catch { return invalid('Brak dostępu do firmy.', 403); }
  if (!access.canEdit) return invalid('Masz dostęp tylko do odczytu.', 403);
  const { client } = access;
  const applicant = await client.from('applications').select('id')
    .eq('company_id', companyId).eq('recruitment_id', recruitmentId)
    .eq('id', applicationId).maybeSingle();
  if (applicant.error || !applicant.data) return invalid('Nie znaleziono zgłoszenia.', 404);

  if (action === 'seed' || action === 'add') {
    if (!isUuid(input.analysisId)) return invalid('Wybierz ukończoną analizę.');
    const analysisId = String(input.analysisId);
    const source = await client.from('evidence_analysis').select('*')
      .eq('organization_id', companyId).eq('recruitment_id', recruitmentId)
      .eq('application_id', applicationId).eq('id', analysisId).eq('status', 'done').maybeSingle();
    if (source.error || !source.data) return invalid('Brak ukończonej analizy.', 409);
    const evidence = await client.from('evidence_item').select('*')
      .eq('organization_id', companyId).eq('analysis_id', analysisId);
    if (evidence.error) return invalid('Nie udało się odczytać zatwierdzonych dowodów.', 503);
    const eligible = reviewedGaps(evidence.data || [], source.data.requirements_snapshot);
    const existing = await client.from('interview_questions').select('sort_order')
      .eq('organization_id', companyId).eq('application_id', applicationId)
      .eq('analysis_id', analysisId).order('sort_order', { ascending: false }).limit(1);
    if (existing.error) return invalid('Nie udało się odczytać przewodnika.', 503);
    let order = (existing.data[0]?.sort_order ?? 0);
    if (action === 'seed') {
      if (!eligible.length) return invalid('Najpierw zatwierdź w kroku 3 wiersze z lukami wymagającymi pytania.', 409);
      let created = 0;
      for (const gap of eligible) {
        order += 1000;
        const inserted = await client.from('interview_questions').insert({
          organization_id: companyId, recruitment_id: recruitmentId,
          application_id: applicationId, analysis_id: analysisId, evidence_item_id: gap.itemId,
          origin: 'generated', question_text: gap.questionText, sort_order: order,
        });
        // Idempotent retry: unique partial index prevents duplicate generated questions.
        if (inserted.error && inserted.error.code !== '23505') {
          return invalid('Przewodnik zapisany częściowo. Ponów tworzenie, aby uzupełnić brakujące pytania.', 409);
        }
        if (!inserted.error) created++;
      }
      return NextResponse.json({ saved: true, created });
    }
    if (!isUuid(input.evidenceItemId) || !validText(input.questionText, 2000)) {
      return invalid('Wybierz dowód i podaj treść pytania.');
    }
    if (!eligible.some(g => g.itemId === input.evidenceItemId)) {
      return invalid('Pytanie musi wskazywać zatwierdzoną przez człowieka lukę.', 409);
    }
    const added = await client.from('interview_questions').insert({
      organization_id: companyId, recruitment_id: recruitmentId, application_id: applicationId,
      analysis_id: analysisId, evidence_item_id: String(input.evidenceItemId),
      origin: 'manual', question_text: trimmed(input.questionText), sort_order: order + 1000,
    });
    return added.error ? invalid('Nie zapisano pytania.', 409) : NextResponse.json({ saved: true });
  }

  if (action === 'question' || action === 'move') {
    if (!isUuid(input.questionId) || !Number.isInteger(input.version) || Number(input.version) < 1) {
      return invalid('Nieprawidłowa wersja pytania.');
    }
    const questionId = String(input.questionId), version = Number(input.version);
    let values: { question_text?: string; is_active?: boolean; sort_order?: number };
    if (action === 'question') {
      if (!validText(input.questionText, 2000) || typeof input.isActive !== 'boolean') {
        return invalid('Sprawdź pytanie i jego widoczność.');
      }
      values = { question_text: trimmed(input.questionText), is_active: input.isActive };
    } else {
      if (!isUuid(input.analysisId) || !['up','down'].includes(String(input.direction))) {
        return invalid('Nieprawidłowe przesunięcie.');
      }
      const { data, error } = await client.from('interview_questions').select('id,sort_order')
        .eq('organization_id', companyId).eq('application_id', applicationId)
        .eq('analysis_id', String(input.analysisId)).eq('is_active', true)
        .order('sort_order').order('id');
      if (error || !data) return invalid('Nie udało się wczytać kolejności.', 503);
      const index = data.findIndex(x => x.id === questionId);
      if (index < 0) return invalid('Nie znaleziono pytania.', 404);
      const move = input.direction === 'up' ? -1 : 1;
      const nextIndex = index + move;
      if (nextIndex < 0 || nextIndex >= data.length) return NextResponse.json({ saved: true });
      const adjacent = data[nextIndex].sort_order;
      const other = data[nextIndex + move]?.sort_order;
      const order = other === undefined ? adjacent + move * 1000 : (adjacent + other) / 2;
      if (order <= 0 || order >= 1000000000 || Math.abs(order - adjacent) < 0.0000001) {
        return invalid('Brak miejsca w kolejności. Skontaktuj się z administratorem.', 409);
      }
      values = { sort_order: order };
    }
    const update = await client.from('interview_questions').update(values)
      .eq('organization_id', companyId).eq('recruitment_id', recruitmentId)
      .eq('application_id', applicationId).eq('id', questionId)
      .eq('version', version).select('id').maybeSingle();
    return update.error || !update.data
      ? invalid('Pytanie zmieniono w innym oknie. Odśwież przed zapisem.', 409)
      : NextResponse.json({ saved: true });
  }

  if (action === 'note') {
    if (!isUuid(input.questionId) || !Number.isInteger(input.version) ||
        Number(input.version) < 0 || typeof input.answerText !== 'string' ||
        typeof input.observationText !== 'string' || input.answerText.length > 12000 ||
        input.observationText.length > 12000) return invalid('Sprawdź treść notatki i wersję.');
    const question = await client.from('interview_questions').select('id')
      .eq('organization_id', companyId).eq('recruitment_id', recruitmentId)
      .eq('application_id', applicationId).eq('id', String(input.questionId)).maybeSingle();
    if (question.error || !question.data) return invalid('Nie znaleziono pytania.', 404);
    const payload = { answer_text: input.answerText, observation_text: input.observationText };
    const result = Number(input.version) === 0
      ? await client.from('interview_question_notes').insert({
          organization_id: companyId, question_id: String(input.questionId), ...payload,
        }).select('version,updated_at,updated_by').maybeSingle()
      : await client.from('interview_question_notes').update(payload)
          .eq('organization_id', companyId).eq('question_id', String(input.questionId))
          .eq('version', Number(input.version)).select('version,updated_at,updated_by').maybeSingle();
    return result.error || !result.data
      ? invalid('Notatka zmieniona w innym oknie. Skopiuj tekst, odśwież i porównaj.', 409)
      : NextResponse.json({ saved: true, ...result.data });
  }

  if (action === 'stage') {
    if (!isUuid(input.stageId) ||
        (input.previousEventId !== null && !isUuid(input.previousEventId)) ||
        typeof input.reason !== 'string' || input.reason.length > 2000) {
      return invalid('Wybierz etap i sprawdź uzasadnienie.');
    }
    const move = await client.from('application_stage_transitions').insert({
      organization_id: companyId, recruitment_id: recruitmentId, application_id: applicationId,
      stage_id: String(input.stageId), reason: trimmed(input.reason),
      expected_previous_event_id: input.previousEventId as string | null,
    });
    return move.error
      ? invalid('Nie przesunięto kandydata. Etap mógł ulec zmianie — odśwież.', 409)
      : NextResponse.json({ saved: true });
  }

  if (action === 'decision') {
    // Deliberately NO generated suggestion, default decision, or automatic call site.
    let human;
    try { human = parseHumanDecision(input.decision, input.justification); }
    catch (error) { return invalid(error instanceof Error ? error.message : 'Wybierz decyzję.'); }
    const result = await client.from('human_candidate_decisions').insert({
      organization_id: companyId, recruitment_id: recruitmentId, application_id: applicationId,
      ...human,
    });
    return result.error ? invalid('Nie zapisano decyzji człowieka.', 409) : NextResponse.json({ saved: true });
  }
  return invalid('Nieznana operacja.');
}
