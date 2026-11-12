'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { exerciseContext } from '../../../../../../lib/exercise-context';
import { assessmentCenterPreviewEnabled } from '../../../../../../lib/assessment-center-preview';
import { acChangeAssessments, acStageTypes, parseAssessmentCenterSession, parseReconciliationForm } from '../../../../../../lib/assessment-center-session';
import { hrbpCaseTemplate } from '../../../../../../lib/assessment-center-session-template';

/**
 * SC-AC-SESSION (#276) server actions. Every action re-derives the session from the
 * recruitment in the URL, so an id from another recruitment or company is never a
 * target. SQL validates and authorizes again; nothing here decides about a candidate.
 */
export type AcSessionRoute = { companyId: string; recruitmentId: string };
export type AcSessionActionState = { error?: string; saved?: boolean };
type EntryKind = 'first_attempt' | 'feedback' | 'revised_attempt' | 'change_proof' | 'expert_consultation';
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const path = (route: AcSessionRoute) => `/dashboard/${route.companyId}/recruitments/${route.recruitmentId}/assessment-center`;
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === 'string' ? value : ''; };

function failure(error: { code?: string; message?: string }): AcSessionActionState {
  const message = error.message ?? '';
  if (error.code === 'PT422') {
    if (message.includes('Coverage plan incomplete')) return { error: 'Plan pokrycia ma lukę: co najmniej jedna kompetencja nie ma etapu, który ją ocenia. Dodaj etap z odpowiednim kryterium.' };
    if (message.includes('Finalist limit reached')) return { error: 'W sesji może być najwyżej 10 finalistów.' };
    if (message.includes('Stage limit reached')) return { error: 'Sesja może mieć najwyżej 8 etapów.' };
    return { error: 'Sesja wymaga co najmniej jednego etapu i jednego finalisty.' };
  }
  if (message.includes('Stage revision already has assessments')) return { error: 'To ćwiczenie ma już przypisanych asesorów poza sesją. Zapisz nową wersję ćwiczenia i wybierz ją jako etap.' };
  if (error.code === 'PT409') return { error: 'Stan sesji zmienił się albo zapis już istnieje. Odśwież stronę i sprawdź, co zostało zapisane.' };
  if (error.code === '22023') return { error: 'Sprawdź wypełnione pola: brakuje wymaganej treści albo jest za krótka.' };
  if (message.includes('Finalist must be shortlisted')) return { error: 'Finalistą może być tylko osoba z aktualnej krótkiej listy tej rekrutacji.' };
  if (message.includes('Session is not open')) return { error: 'Sesja nie jest otwarta. W szkicu i po zamknięciu nie można dodawać ocen, uzgodnień ani zapisów.' };
  if (message.includes('Assessor required')) return { error: 'Ten zapis może dodać tylko asesor przypisany do tego etapu.' };
  return { error: 'Nie zapisano. Sprawdź uprawnienia oraz stan rekrutacji i sesji.' };
}

type Failure = { error: string };
type Base = Awaited<ReturnType<typeof exerciseContext>>;
async function context(route: AcSessionRoute, ownerOnly: boolean): Promise<Failure | { base: Base }> {
  if (!assessmentCenterPreviewEnabled()) return { error: 'Sesje Assessment Center są niedostępne.' };
  const base = await exerciseContext(route.companyId, route.recruitmentId);
  if (!base.canEdit || (ownerOnly && base.company.owner_id !== base.user.id)) return { error: 'Brak dostępu do tej czynności.' };
  return { base };
}
async function sessionOf(route: AcSessionRoute, ownerOnly: boolean): Promise<Failure | { base: Base; sessionId: string }> {
  const loaded = await context(route, ownerOnly);
  if ('error' in loaded) return loaded;
  const found = await loaded.base.client.rpc('ac_session_find', { recruitment: route.recruitmentId });
  if (found.error || !found.data) return { error: 'Nie znaleziono sesji tej rekrutacji. Odśwież stronę.' };
  return { base: loaded.base, sessionId: found.data };
}
function done(route: AcSessionRoute): AcSessionActionState { revalidatePath(path(route)); return { saved: true }; }

export async function createAcSession(route: AcSessionRoute, _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const loaded = await context(route, true);
  if ('error' in loaded) return loaded;
  const competencies = field(form, 'competencies').split('\n').map(line => line.trim()).filter(Boolean);
  const result = await loaded.base.client.rpc('ac_session_create', { recruitment: route.recruitmentId, session_title: field(form, 'title'), competencies });
  return result.error ? failure(result.error) : done(route);
}

/** Synthetic HRBP case: four human-authored rubrics saved as exact revisions, then pinned as stages. */
export async function createAcSessionFromTemplate(route: AcSessionRoute, _previous: AcSessionActionState, _form: FormData): Promise<AcSessionActionState> {
  const loaded = await context(route, true);
  if ('error' in loaded) return loaded;
  const { client, position } = loaded.base;
  const created = await client.rpc('ac_session_create', { recruitment: route.recruitmentId,
    session_title: hrbpCaseTemplate.title, competencies: hrbpCaseTemplate.plannedCompetencies });
  if (created.error) return failure(created.error);
  for (const stage of hrbpCaseTemplate.stages) {
    const revision = await client.rpc('save_exercise_definition', { target_recruitment: route.recruitmentId, target_exercise: randomUUID(),
      new_definition: stage.definition, expected_version: 0, expected_position_id: position.id, expected_position_updated_at: position.updated_at });
    if (revision.error || !revision.data) { revalidatePath(path(route)); return { error: 'Utworzono sesję, ale nie wszystkie etapy szablonu. Dodaj brakujące etapy ręcznie.' }; }
    const added = await client.rpc('ac_session_add_stage', { session: created.data, kind: stage.type, stage_title: stage.title,
      revision: revision.data, counterpart: stage.counterpartBrief });
    if (added.error) { revalidatePath(path(route)); return { error: 'Utworzono sesję, ale nie wszystkie etapy szablonu. Dodaj brakujące etapy ręcznie.' }; }
  }
  return done(route);
}

export async function addAcSessionStage(route: AcSessionRoute, _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, true);
  if ('error' in loaded) return loaded;
  const kind = field(form, 'kind'), revision = field(form, 'revision');
  if (!acStageTypes.some(([key]) => key === kind) || !uuid.test(revision)) return { error: 'Wybierz rodzaj etapu i ćwiczenie Assessment Center.' };
  const result = await loaded.base.client.rpc('ac_session_add_stage', { session: loaded.sessionId, kind, stage_title: field(form, 'title'),
    revision, counterpart: kind === 'human_simulation' ? field(form, 'counterpart') : null });
  return result.error ? failure(result.error) : done(route);
}

export async function removeLastAcSessionStage(route: AcSessionRoute, _previous: AcSessionActionState, _form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, true);
  if ('error' in loaded) return loaded;
  const result = await loaded.base.client.rpc('ac_session_remove_last_stage', { session: loaded.sessionId });
  return result.error ? failure(result.error) : done(route);
}

export async function addAcSessionFinalist(route: AcSessionRoute, _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, true);
  if ('error' in loaded) return loaded;
  const application = field(form, 'application');
  if (!uuid.test(application)) return { error: 'Wybierz osobę z krótkiej listy.' };
  const result = await loaded.base.client.rpc('ac_session_add_finalist', { session: loaded.sessionId, application });
  return result.error ? failure(result.error) : done(route);
}

export async function removeAcSessionFinalist(route: AcSessionRoute, applicationId: string, _previous: AcSessionActionState, _form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, true);
  if ('error' in loaded) return loaded;
  if (!uuid.test(applicationId)) return { error: 'Nieprawidłowy finalista.' };
  const result = await loaded.base.client.rpc('ac_session_remove_finalist', { session: loaded.sessionId, application: applicationId });
  return result.error ? failure(result.error) : done(route);
}

export async function setAcSessionStatus(route: AcSessionRoute, status: 'open' | 'closed', _previous: AcSessionActionState, _form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, true);
  if ('error' in loaded) return loaded;
  const result = await loaded.base.client.rpc('ac_session_set_status', { session: loaded.sessionId, next_status: status });
  return result.error ? failure(result.error) : done(route);
}

export async function assignAcSessionPair(route: AcSessionRoute, stageId: string, applicationId: string, _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, true);
  if ('error' in loaded) return loaded;
  const first = field(form, 'first'), second = field(form, 'second');
  if (![stageId, applicationId, first, second].every(id => uuid.test(id)) || first === second) return { error: 'Wybierz dwie różne osoby z zespołu.' };
  const result = await loaded.base.client.rpc('ac_session_assign_pair', { session: loaded.sessionId, stage: stageId, application: applicationId, first_id: first, second_id: second });
  return result.error ? failure(result.error) : done(route);
}

export async function recordAcSessionEntry(route: AcSessionRoute, applicationId: string, stageId: string | null, kind: EntryKind,
  _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const loaded = await sessionOf(route, false);
  if ('error' in loaded) return loaded;
  if (!uuid.test(applicationId) || (stageId !== null && !uuid.test(stageId))) return { error: 'Nieprawidłowy zapis.' };
  let entry: Record<string, string>;
  if (kind === 'first_attempt' || kind === 'revised_attempt') entry = { work: field(form, 'work') };
  else if (kind === 'feedback') entry = { feedback: field(form, 'feedback') };
  else if (kind === 'expert_consultation') entry = { note: field(form, 'note') };
  else if (kind === 'change_proof') {
    const assessment = field(form, 'assessment');
    if (!acChangeAssessments.some(([key]) => key === assessment)) return { error: 'Wybierz, co pokazuje dowód zmiany.' };
    entry = { changes: field(form, 'changes'), evidence: assessment === 'insufficient_data' ? '' : field(form, 'evidence'), assessment };
  } else return { error: 'Nieprawidłowy zapis.' };
  const result = await loaded.base.client.rpc('ac_session_record_entry', { session: loaded.sessionId, application: applicationId,
    stage: kind === 'expert_consultation' ? null : stageId, entry_kind: kind, entry });
  return result.error ? failure(result.error) : done(route);
}

/** The pair must be a submitted pair of THIS session; the criteria count comes from the session, not the form. */
async function readyPair(route: AcSessionRoute, pairId: string): Promise<Failure | { client: Base['client']; criteria: number }> {
  const loaded = await sessionOf(route, false);
  if ('error' in loaded) return loaded;
  if (!uuid.test(pairId)) return { error: 'Nieprawidłowy arkusz.' };
  const read = await loaded.base.client.rpc('ac_session_read', { session: loaded.sessionId });
  if (read.error) return { error: 'Nie udało się wczytać sesji.' };
  let session;
  try { session = parseAssessmentCenterSession(read.data); } catch { return { error: 'Nie udało się zweryfikować danych sesji.' }; }
  for (const finalist of session.finalists) {
    const index = finalist.stages.findIndex(stage => stage.pair.state === 'ready' && stage.pair.pairId === pairId);
    if (index >= 0) return { client: loaded.base.client, criteria: session.stages[index].definition.criteria.length };
  }
  return { error: 'Uzgodnienie jest możliwe dopiero po oddaniu obu arkuszy przez asesorów tego etapu.' };
}

export async function recordAcReconciliation(route: AcSessionRoute, pairId: string, _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const found = await readyPair(route, pairId);
  if ('error' in found) return found;
  let decisions;
  try { decisions = parseReconciliationForm(found.criteria, form); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Sprawdź uzgodnienie.' }; }
  const result = await found.client.rpc('ac_record_reconciliation', { pair_id: pairId, decisions });
  if (result.error?.code === '22023') return { error: 'Uzgodniona ocena musi być jedną z dwóch oddanych ocen, a rozbieżność można zapisać tylko przy różnych ocenach.' };
  return result.error ? failure(result.error) : done(route);
}

export async function confirmAcReconciliation(route: AcSessionRoute, pairId: string, _previous: AcSessionActionState, form: FormData): Promise<AcSessionActionState> {
  const found = await readyPair(route, pairId);
  if ('error' in found) return found;
  const verdict = field(form, 'verdict');
  if (verdict !== 'confirmed' && verdict !== 'disputed') return { error: 'Wybierz: potwierdzam albo nie zgadzam się.' };
  const result = await found.client.rpc('ac_confirm_reconciliation', { pair_id: pairId, verdict, note: verdict === 'disputed' ? field(form, 'note') : null });
  return result.error ? failure(result.error) : done(route);
}
