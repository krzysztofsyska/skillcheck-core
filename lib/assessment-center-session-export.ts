// SC-AC-SESSION-EXPORT — CSV podsumowania sesji Assessment Center dla jednej rekrutacji.
//
// Zasady:
//  * odczyt wyłącznie przez klienta RLS zalogowanego użytkownika (nigdy service_role);
//    te same zapytania i to samo RPC (ac_session_find / ac_session_read) co strona sesji,
//    więc baza decyduje o widoczności dokładnie tak samo jak na ekranie;
//  * dostęp jak na stronie: właściciel firmy albo rekruter, rekrutacja i stanowisko tej firmy;
//  * zasada ślepej oceny: gdy użytkownik nie oddał jeszcze swojego niezależnego arkusza
//    (textHidden), plik nie zawiera tego, co zapisali inni (informacja zwrotna, dowód zmiany,
//    uzasadnienia i opisy rozbieżności) — tylko oznaczenie, że są niewidoczne;
//  * plik zawiera tylko oceny, stan uzgodnienia i znaczniki prób, które pokazuje strona;
//    bez wyniku ogólnego, rankingu i rekomendacji;
//  * nazwa pliku zawiera tylko identyfikator rekrutacji i datę, nigdy nazwisk;
//  * każda komórka przechodzi przez csvCell (ochrona przed formułami);
//  * komunikaty błędów nie zdradzają, czy rekord innej firmy istnieje; nic nie trafia do logów;
//  * SC-AC-EXPORT-AUDIT: bez udanego wpisu audytowego nie ma pliku (fail closed). Tuż przed
//    wydaniem pliku baza jeszcze raz sprawdza rolę (właściciel/rekruter) i przynależność sesji
//    (public.record_assessment_center_session_export); wpis zawiera tylko identyfikatory i rolę.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { behaviorRatings } from './behavior-assessment.ts';
import { exercisePositionMatches, exerciseRecruitmentMatches, exerciseUuid } from './exercise-context-identity.ts';
import {
  AC_NO_DATA, acChangeAssessments, buildAssessmentCenterSessionReport, parseAssessmentCenterSession,
  type AcCriterionAgreement, type AcEvidenceGap, type AssessmentCenterSession, type AssessmentCenterSessionReport,
} from './assessment-center-session.ts';
import { csvCell } from './screening-report.ts';

// v2 (#338): dodana sekcja „Brak dowodu” na końcu pliku; wcześniejsze sekcje bez zmian.
export const AC_SESSION_EXPORT_VERSION = 'ac-session-csv-v2';
export const AC_TEXT_WITHHELD = 'niewidoczne do czasu oddania Twojego arkusza';
export const acSessionExportHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const MAX_CSV_BYTES = 10 * 1024 * 1024;

// Etykiety wspólne ze stroną sesji (app/.../assessment-center/page.tsx).
export const acRatingLabel = (value: string) => behaviorRatings.find(([key]) => key === value)?.[1] ?? AC_NO_DATA;
export const acChangeLabel = (value: string) => acChangeAssessments.find(([key]) => key === value)?.[1] ?? AC_NO_DATA;
export const acSessionStatusLabel = { draft: 'Plan w przygotowaniu', open: 'Sesja otwarta', closed: 'Sesja zamknięta' } as const;

/** Ten sam tekst stanu uzgodnienia, który strona pokazuje pod ocenami asesorów. */
export function acAgreementText(value: AcCriterionAgreement, who: (id: string) => string): string {
  switch (value.status) {
    case 'not_assessed': return `Uzgodnienie: ${AC_NO_DATA} — nie przypisano asesorów.`;
    case 'restricted': return 'Arkusze widzą tylko dwaj asesorzy tego etapu i właściciel firmy.';
    case 'awaiting_second_sheet': return `Uzgodnienie: ${AC_NO_DATA} — porównanie będzie dostępne po oddaniu obu arkuszy.`;
    case 'not_reconciled': return value.ratingsDiffer ? 'Różne oceny asesorów — wymagane uzgodnienie albo zapis rozbieżności.' : 'Oceny zgodne — brak zapisu uzgodnienia.';
    case 'awaiting_confirmation': return `Propozycja uzgodnienia (${who(value.recordedBy)}): ${acRatingLabel(value.rating)} — ${value.justification}. Czeka na odpowiedź drugiego asesora.`;
    case 'agreed': return `Uzgodniono: ${acRatingLabel(value.rating)} — ${value.justification} (zapis: ${who(value.recordedBy)}, potwierdzony przez drugiego asesora).`;
    case 'discrepancy': return `Jawna rozbieżność — obie oceny pozostają: ${value.note} (zapis: ${who(value.recordedBy)}${value.awaitingConfirmation ? ', czeka na odpowiedź drugiego asesora' : ''}).`;
    case 'disputed': return `Zapis uzgodnienia zakwestionowany przez ${who(value.disputedBy)}: ${value.disputeNote}. Obie oceny pozostają jako rozbieżność.`;
  }
}

/**
 * #338: jawny opis braku dowodu — ten sam tekst na stronie sesji i w pliku. Bez treści
 * zapisanych przez kogokolwiek; przy niewidocznych arkuszach mówi tylko, że są niewidoczne.
 */
export function acEvidenceGapText(gap: AcEvidenceGap, who: (id: string) => string): string {
  switch (gap.reason) {
    case 'no_stage': return 'Brak etapu oceniającego tę kompetencję.';
    case 'not_assigned': return 'Nie przypisano asesorów — brak arkuszy.';
    case 'restricted': return 'Nie można sprawdzić — arkusze widzą tylko dwaj przypisani asesorzy i właściciel firmy.';
    case 'awaiting_sheets': return 'Czeka na oddanie obu niezależnych arkuszy.';
    case 'insufficient_data': return `Niewystarczające dane, bez dowodu: ${gap.assessors
      .map(item => `Asesor ${item.position} (${who(item.authorId)})`).join(', ')}.`;
  }
}
export const AC_NO_GAPS = 'Brak braków: każda kompetencja ma dowód od obu asesorów w każdym etapie.';

/** Krótki wynik uzgodnienia do jednej kolumny: uzgodniona ocena albo jawne „rozbieżność”. */
function agreementOutcome(value: AcCriterionAgreement): string {
  switch (value.status) {
    case 'agreed': return acRatingLabel(value.rating);
    case 'awaiting_confirmation': return `${acRatingLabel(value.rating)} (czeka na potwierdzenie)`;
    case 'discrepancy': return value.awaitingConfirmation ? 'rozbieżność (czeka na potwierdzenie)' : 'rozbieżność';
    case 'disputed': return 'rozbieżność (zapis zakwestionowany)';
    case 'not_reconciled': return value.ratingsDiffer ? 'rozbieżność (bez zapisu uzgodnienia)' : 'oceny zgodne (bez zapisu uzgodnienia)';
    default: return AC_NO_DATA;
  }
}
/** Wersja bez tekstów pisanych przez asesorów — dla zasady ślepej oceny. */
function agreementWithoutText(value: AcCriterionAgreement, who: (id: string) => string): string {
  if (value.status === 'awaiting_confirmation' || value.status === 'agreed' || value.status === 'discrepancy' || value.status === 'disputed') {
    return `${agreementOutcome(value)} — uzasadnienie ${AC_TEXT_WITHHELD}`;
  }
  return acAgreementText(value, who);
}

/** Etykieta finalisty jak na stronie: imię i nazwisko z kartoteki rekrutacji, inaczej „Finalista”. */
export function acFinalistLabels(
  applications: ReadonlyArray<{ id: string; candidate_id: string }>,
  candidates: ReadonlyArray<{ id: string; first_name: string; last_name: string }>,
) {
  const names = new Map(candidates.map(row => [row.id, `${row.first_name} ${row.last_name}`.trim()]));
  return (applicationId: string) => names.get(applications.find(row => row.id === applicationId)?.candidate_id ?? '') ?? 'Finalista';
}

/** Etykieta, gdy autor zapisu nie jest już w zespole firmy albo zespołu nie udało się wczytać. */
export const AC_ASSESSOR_OUTSIDE_TEAM = 'Osoba spoza obecnego zespołu';
export const AC_ASSESSOR_UNKNOWN = 'Asesor';
type AcTeamMember = { user_id: string; created_at?: string | null };

/**
 * Czytelna etykieta asesora zamiast identyfikatora konta (ROADMAP R3). Bez nowych danych osobowych:
 * „Ty”, „Właściciel firmy” albo „Członek zespołu N” (N = kolejność dołączenia do zespołu firmy,
 * stała między odświeżeniami). Gdy listy zespołu nie ma (null) — neutralne „Asesor”.
 */
export function acAssessorLabels(viewerId: string, ownerId: string, members: ReadonlyArray<AcTeamMember> | null) {
  const ordered = [...(members ?? [])].filter(row => row.user_id !== ownerId)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.user_id.localeCompare(b.user_id));
  const labels = new Map<string, string>();
  for (const row of ordered) if (!labels.has(row.user_id)) labels.set(row.user_id, `Członek zespołu ${labels.size + 1}`);
  return (id: string) => id === viewerId ? 'Ty' : id === ownerId ? 'Właściciel firmy'
    : labels.get(id) ?? (members ? AC_ASSESSOR_OUTSIDE_TEAM : AC_ASSESSOR_UNKNOWN);
}

/** Zespół firmy do etykiet asesorów — ten sam odczyt RLS (company_members) co lista asesorów do przypisania. */
export async function loadAcTeam(client: Client, companyId: string) {
  const members = await client.from('company_members').select('user_id,role,created_at').eq('company_id', companyId);
  return members.error ? null : members.data;
}

export type AcSessionExport = {
  recruitmentId: string; recruitmentName: string; generatedAt: string; viewerId: string;
  report: AssessmentCenterSessionReport; finalistLabel: (applicationId: string) => string;
  /** Etykieta asesora (acAssessorLabels); bez niej — tylko „Ty” albo neutralne „Asesor”, nigdy identyfikator. */
  assessorLabel?: (userId: string) => string;
};

export function acSessionExportFilename(recruitmentId: string, generatedAt: string) {
  if (!exerciseUuid.test(recruitmentId)) throw new AcSessionExportError('invalid');
  const day = /^\d{4}-\d{2}-\d{2}/.exec(generatedAt)?.[0];
  if (!day) throw new AcSessionExportError('failed');
  return `skillcheck-assessment-center-${recruitmentId.toLowerCase()}-${day}.csv`;
}

export function acSessionCsv(data: AcSessionExport): string {
  const { report } = data;
  const who = data.assessorLabel ?? ((id: string) => id === data.viewerId ? 'Ty' : AC_ASSESSOR_UNKNOWN);
  const rows: (string | number | null)[][] = [
    ['Wersja eksportu', AC_SESSION_EXPORT_VERSION], ['Wygenerowano (UTC)', data.generatedAt],
    ['Rekrutacja', data.recruitmentName], ['Identyfikator rekrutacji', data.recruitmentId],
    ['Sesja', report.title], ['Status sesji', acSessionStatusLabel[report.status]],
    ['Informacja', 'Plik zestawia dowody z obserwacji. Nie wylicza wyniku, nie tworzy rankingu i nie podejmuje decyzji o zatrudnieniu — decyzję podejmuje człowiek. Kolejność finalistów to kolejność dodania do sesji.'],
    [],
    ['Finalista', 'Zgłoszenie', 'Kompetencja', 'Etap', 'Asesor 1', 'Ocena asesora 1', 'Asesor 2', 'Ocena asesora 2', 'Wynik uzgodnienia', 'Stan uzgodnienia', 'Status sesji'],
  ];
  for (const finalist of report.finalists) {
    const label = data.finalistLabel(finalist.applicationId);
    for (const item of finalist.competencies) {
      if (!item.evidence.length) {
        rows.push([label, finalist.applicationId, item.competency, AC_NO_DATA, '', AC_NO_DATA, '', AC_NO_DATA, AC_NO_DATA,
          'Brak etapu oceniającego tę kompetencję.', acSessionStatusLabel[report.status]]);
      }
      for (const row of item.evidence) {
        const [first, second] = row.assessors;
        rows.push([
          label, finalist.applicationId, item.competency, row.stageTitle,
          first ? who(first.authorId) : '', first ? acRatingLabel(first.rating) : AC_NO_DATA,
          second ? who(second.authorId) : '', second ? acRatingLabel(second.rating) : AC_NO_DATA,
          agreementOutcome(row.agreement),
          finalist.textHidden ? agreementWithoutText(row.agreement, who) : acAgreementText(row.agreement, who),
          acSessionStatusLabel[report.status],
        ]);
      }
    }
  }
  rows.push([], ['Finalista', 'Zgłoszenie', 'Etap', 'Pierwsza próba', 'Informacja zwrotna asesora', 'Poprawiona praca (druga próba)', 'Dowód zmiany']);
  for (const finalist of report.finalists) {
    const label = data.finalistLabel(finalist.applicationId);
    const hidden = finalist.textHidden ? AC_TEXT_WITHHELD : AC_NO_DATA;
    for (const attempt of finalist.attempts) {
      // Zasada ślepej oceny także wtedy, gdyby dane jednak zawierały wpis innej osoby.
      const feedback = !finalist.textHidden && attempt.feedback;
      const proof = !finalist.textHidden && attempt.changeProof;
      rows.push([
        label, finalist.applicationId, attempt.stageTitle,
        attempt.firstAttempt ? 'zapisana' : AC_NO_DATA,
        feedback ? 'zapisana' : hidden,
        attempt.revisedAttempt ? 'zapisana' : AC_NO_DATA,
        proof ? acChangeLabel(proof.assessment) : hidden,
      ]);
    }
  }
  // #338: jawne braki dowodów — kompetencja w etapie bez dowodu od obu asesorów (bez tekstów innych osób).
  rows.push([], ['Finalista', 'Zgłoszenie', 'Kompetencja', 'Etap', 'Brak dowodu']);
  for (const finalist of report.finalists) {
    const label = data.finalistLabel(finalist.applicationId);
    if (!finalist.evidenceGaps.length) rows.push([label, finalist.applicationId, '', '', AC_NO_GAPS]);
    for (const gap of finalist.evidenceGaps) {
      rows.push([label, finalist.applicationId, gap.competency, gap.stageTitle ?? AC_NO_DATA, acEvidenceGapText(gap, who)]);
    }
  }
  const csv = '﻿' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) throw new AcSessionExportError('too_large');
  return csv;
}

export type AcSessionExportErrorCode =
  'invalid' | 'unauthenticated' | 'not_found' | 'unavailable' | 'changed' | 'too_large' | 'audit_failed' | 'failed';
const errors: Record<AcSessionExportErrorCode, [number, string]> = {
  invalid: [400, 'Nieprawidłowy adres sesji.'],
  unauthenticated: [401, 'Zaloguj się, aby pobrać podsumowanie sesji.'],
  not_found: [404, 'Nie znaleziono sesji Assessment Center lub nie masz do niej dostępu.'],
  unavailable: [503, 'Sesje Assessment Center nie są jeszcze dostępne w tym środowisku.'],
  changed: [409, 'Nie udało się zweryfikować danych sesji. Plik nie został przygotowany.'],
  too_large: [413, 'Podsumowanie przekracza dopuszczalny rozmiar pliku.'],
  audit_failed: [503, 'Nie udało się zapisać wpisu o pobraniu podsumowania, więc plik nie został wydany. Spróbuj ponownie.'],
  failed: [500, 'Nie udało się przygotować pliku. Spróbuj ponownie.'],
};
export class AcSessionExportError extends Error {
  code: AcSessionExportErrorCode;
  status: number;
  constructor(code: AcSessionExportErrorCode) { super(errors[code][1]); this.code = code; this.status = errors[code][0]; }
}

type Client = SupabaseClient<Database>;
/** Ten sam odczyt sesji co strona: znajdź sesję rekrutacji, odczytaj ją przez RPC i zweryfikuj całość. */
export async function readAcSession(client: Client, recruitmentId: string):
  Promise<{ state: 'unavailable' } | { state: 'none' } | { state: 'error' } | { state: 'invalid' } | { state: 'ok'; session: AssessmentCenterSession }> {
  const found = await client.rpc('ac_session_find', { recruitment: recruitmentId });
  if (found.error) return { state: 'unavailable' };
  if (!found.data) return { state: 'none' };
  const read = await client.rpc('ac_session_read', { session: found.data });
  if (read.error) return { state: 'error' };
  try { return { state: 'ok', session: parseAssessmentCenterSession(read.data) }; }
  catch { return { state: 'invalid' }; }
}

/** Etykiety finalistów tej rekrutacji — te same zapytania co na stronie. */
export async function loadAcFinalistLabels(client: Client, companyId: string, recruitmentId: string) {
  const applications = await client.from('applications').select('id,candidate_id').eq('company_id', companyId).eq('recruitment_id', recruitmentId);
  if (applications.error) return null;
  const candidateIds = Array.from(new Set(applications.data.map(row => row.candidate_id)));
  const candidates = candidateIds.length
    ? await client.from('candidates').select('id,first_name,last_name').eq('company_id', companyId).in('id', candidateIds) : null;
  return acFinalistLabels(applications.data, candidates?.data ?? []);
}

/**
 * Sprawdzenia dostępu ze strony (companyAccess + exerciseContext + canEdit), ale z kodem
 * błędu zamiast przekierowania. Odczyt przez tego samego klienta RLS użytkownika.
 */
async function accessContext(client: Client, companyId: string, recruitmentId: string) {
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth?.user) throw new AcSessionExportError('unauthenticated');
  const user = auth.user;
  const company = await client.from('companies').select('id,owner_id').eq('id', companyId).maybeSingle();
  if (company.error) throw new AcSessionExportError('failed');
  if (!company.data || String(company.data.id).toLowerCase() !== companyId) throw new AcSessionExportError('not_found');
  const membership = await client.from('company_members').select('role').eq('company_id', companyId).eq('user_id', user.id).maybeSingle();
  if (membership.error) throw new AcSessionExportError('failed');
  if (company.data.owner_id !== user.id && membership.data?.role !== 'recruiter') throw new AcSessionExportError('not_found');
  const recruitment = await client.from('recruitments').select('id,company_id,position_id,name').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) throw new AcSessionExportError('failed');
  if (!recruitment.data || !exerciseRecruitmentMatches(recruitment.data, companyId, recruitmentId)) throw new AcSessionExportError('not_found');
  const position = await client.from('positions').select('id,company_id').eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle();
  if (position.error) throw new AcSessionExportError('failed');
  if (!position.data || !exercisePositionMatches(position.data, companyId, recruitment.data.position_id)) throw new AcSessionExportError('not_found');
  return { user, ownerId: company.data.owner_id, recruitment: recruitment.data };
}

const uuidResult = (value: unknown): value is string => typeof value === 'string' && exerciseUuid.test(value);

/** Zapis audytowy przed wydaniem pliku. Każdy błąd lub niepoprawna odpowiedź = brak pliku. */
async function recordAcSessionExport(client: Client, companyId: string, recruitmentId: string, sessionId: string) {
  let result: { data: unknown; error: { code?: string } | null };
  try {
    result = await client.rpc('record_assessment_center_session_export', {
      target_company: companyId, target_recruitment: recruitmentId, target_session: sessionId, export_kind: 'ac_session_csv',
    });
  } catch { throw new AcSessionExportError('audit_failed'); }
  if (result.error) {
    // Baza odmówiła dostępu (np. rola odebrana między odczytem a zapisem): jak strona — 404.
    if (result.error.code === '42501') throw new AcSessionExportError('not_found');
    throw new AcSessionExportError('audit_failed');
  }
  if (!uuidResult(result.data)) throw new AcSessionExportError('audit_failed');
}

type ExportOptions = { enabled: boolean; now?: () => Date };
export async function exportAcSession(
  client: Client, route: { companyId: string; recruitmentId: string }, { enabled, now = () => new Date() }: ExportOptions,
): Promise<Response> {
  try {
    // Strona sesji istnieje tylko przy włączonym podglądzie; eksport tak samo.
    if (!enabled) throw new AcSessionExportError('not_found');
    if (!route || !exerciseUuid.test(route.companyId) || !exerciseUuid.test(route.recruitmentId)) throw new AcSessionExportError('invalid');
    const companyId = route.companyId.toLowerCase(), recruitmentId = route.recruitmentId.toLowerCase();
    const { user, ownerId, recruitment } = await accessContext(client, companyId, recruitmentId);
    const read = await readAcSession(client, recruitmentId);
    if (read.state === 'unavailable') throw new AcSessionExportError('unavailable');
    if (read.state === 'none') throw new AcSessionExportError('not_found');
    if (read.state === 'error') throw new AcSessionExportError('failed');
    if (read.state === 'invalid') throw new AcSessionExportError('changed');
    // Sesja musi dotyczyć dokładnie tej rekrutacji, o którą poproszono.
    if (read.session.session.recruitmentId.toLowerCase() !== recruitmentId) throw new AcSessionExportError('changed');
    const finalistLabel = await loadAcFinalistLabels(client, companyId, recruitmentId);
    if (!finalistLabel) throw new AcSessionExportError('failed');
    const team = await loadAcTeam(client, companyId);
    if (!team) throw new AcSessionExportError('failed');
    const generatedAt = now().toISOString();
    const csv = acSessionCsv({
      recruitmentId, recruitmentName: recruitment.name, generatedAt, viewerId: user.id,
      report: buildAssessmentCenterSessionReport(read.session), finalistLabel, assessorLabel: acAssessorLabels(user.id, ownerId, team),
    });
    await recordAcSessionExport(client, companyId, recruitmentId, read.session.session.id.toLowerCase());
    return new Response(csv, { headers: {
      ...acSessionExportHeaders, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${acSessionExportFilename(recruitmentId, generatedAt)}"`,
    } });
  } catch (error) {
    const safe = error instanceof AcSessionExportError ? error : new AcSessionExportError('failed');
    return Response.json({ error: safe.code, message: safe.message }, { status: safe.status, headers: acSessionExportHeaders });
  }
}
