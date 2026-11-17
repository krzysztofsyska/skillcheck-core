// R2-B (ROADMAP R2, krok B) — dane sekcji „Etapy rekrutacji" w raporcie
// jednego kandydata (docs/sc-015-extended-candidate-report.md, sekcja 3).
//
// Sekcja pokazuje aktualny etap, listę etapów rekrutacji w kolejności,
// historię przesunięć i decyzję wpisaną przez człowieka z jego uzasadnieniem —
// jako zapis ręcznej decyzji, nie rekomendację systemu. Notatek z rozmów nie
// czytamy (mogą zawierać dane wrażliwe). Autor wpisu jest opisany rolą, nie
// identyfikatorem ani nazwiskiem.
//
// Odczyt idzie wyłącznie przez klienta RLS zalogowanego użytkownika, nazwanymi
// kolumnami, tymi samymi tabelami co ekran „Etapy oceny". Każdy wiersz jest
// dodatkowo sprawdzany w kodzie (firma → rekrutacja → zgłoszenie); niezgodny
// zapis przerywa sekcję. Błąd odczytu daje neutralny komunikat i nigdy nie psuje
// reszty raportu. Tekst to dane, nie HTML.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { step4Client } from './step4-database.ts';
import { humanDecisions, type HumanDecision } from './interview-decision.ts';
import {
  reportActorLabel, reportRouteValid, reportSchemaMissing, reportTimestamp, reportUuid,
  type ReportRoute, type ReportViewer,
} from './candidate-report-exercises.ts';

/** Najwyżej tyle wpisów historii (przesunięć i decyzji) pokazuje raport, najnowsze pierwsze. */
export const STAGES_HISTORY_LIMIT = 20;

export const stagesSectionMessages = {
  noAccess: 'Etapy rekrutacji widzą właściciel konta firmy i rekruterzy tej firmy.',
  noStages: 'Brak zdefiniowanych etapów.',
  unassigned: 'Nieprzypisany',
  deletedStage: 'Usunięty etap',
  noMoves: 'Brak wcześniejszych przesunięć.',
  noDecision: 'Brak decyzji',
  noDecisions: 'Żadna decyzja nie została podjęta.',
  unavailable: 'Etapy rekrutacji nie są jeszcze dostępne w tym środowisku.',
  error: 'Nie udało się teraz wczytać etapów rekrutacji. Odśwież raport — pozostała część raportu jest aktualna.',
} as const;

export type StageReportMove = { fromStage: string; toStage: string; at: string; actor: string };
export type StageReportDecision = {
  previousDecision: string; newDecision: string; reason: string; at: string; actor: string;
};
export type StagesReportSection =
  | { kind: 'no_access' | 'unavailable' | 'error'; message: string }
  | {
    kind: 'list';
    currentStage: string;
    stages: Array<{ name: string; sequence: number; current: boolean }>;
    moves: StageReportMove[];
    movesTruncated: boolean;
    decision: { label: string; reason: string | null } | null;
    decisions: StageReportDecision[];
    decisionsTruncated: boolean;
  };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Niezgodne dane etapu.');
  return value as Record<string, unknown>;
}
function bound(row: Record<string, unknown>, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) throw new Error('Niezgodne powiązanie etapu.');
  }
}
function optionalId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !reportUuid.test(value)) throw new Error('Niezgodny identyfikator.');
  return value;
}
function decisionValue(value: unknown, nullable: boolean): HumanDecision | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !humanDecisions.some(([key]) => key === value)) throw new Error('Niezgodna decyzja.');
  return value as HumanDecision;
}
export function humanDecisionLabel(value: HumanDecision | null): string {
  return humanDecisions.find(([key]) => key === value)?.[1] ?? stagesSectionMessages.noDecision;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Niezgodny tekst.');
  return value;
}

/**
 * Sekcja „Etapy rekrutacji". Nigdy nie rzuca: każdy błąd, wyjątek albo
 * nieoczekiwany kształt danych daje neutralny komunikat.
 */
export async function loadStagesReportSection(
  originalClient: SupabaseClient<Database>, route: ReportRoute, viewer: ReportViewer,
): Promise<StagesReportSection> {
  if (!viewer.canEdit) return { kind: 'no_access', message: stagesSectionMessages.noAccess };
  try {
    if (!reportRouteValid(route)) return { kind: 'error', message: stagesSectionMessages.error };
    const client = step4Client(originalClient);
    const tenant = { company_id: route.companyId, recruitment_id: route.recruitmentId };
    const scoped = { ...tenant, application_id: route.applicationId };
    const [application, stages, moves, decisions] = await Promise.all([
      client.from('applications')
        .select('id,company_id,recruitment_id,current_stage_id,human_decision,human_decision_reason')
        .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId).eq('id', route.applicationId)
        .maybeSingle(),
      client.from('assessment_stages').select('id,company_id,recruitment_id,name,sequence')
        .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId).order('sequence'),
      client.from('application_stage_events')
        .select('id,company_id,recruitment_id,application_id,from_stage_id,to_stage_id,actor_id,created_at')
        .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId)
        .eq('application_id', route.applicationId).order('created_at', { ascending: false })
        .limit(STAGES_HISTORY_LIMIT + 1),
      client.from('application_decision_events')
        .select('id,company_id,recruitment_id,application_id,previous_decision,new_decision,reason,actor_id,created_at')
        .eq('company_id', route.companyId).eq('recruitment_id', route.recruitmentId)
        .eq('application_id', route.applicationId).order('created_at', { ascending: false })
        .limit(STAGES_HISTORY_LIMIT + 1),
    ]);
    const errors = [application.error, stages.error, moves.error, decisions.error].filter(Boolean);
    if (errors.length) {
      return errors.some(error => reportSchemaMissing(error?.code))
        ? { kind: 'unavailable', message: stagesSectionMessages.unavailable }
        : { kind: 'error', message: stagesSectionMessages.error };
    }
    // Zgłoszenie spoza tej firmy albo rekrutacji (lub niewidoczne przez RLS):
    // ten sam neutralny komunikat, bez zdradzania, czy rekord istnieje.
    if (!application.data) return { kind: 'error', message: stagesSectionMessages.error };
    const app = record(application.data);
    bound(app, { ...tenant, id: route.applicationId });
    if (!Array.isArray(stages.data) || !Array.isArray(moves.data) || !Array.isArray(decisions.data)) {
      throw new Error('Niezgodna lista.');
    }

    const names = new Map<string, string>();
    const stageList = stages.data.map(item => {
      const row = record(item);
      bound(row, tenant);
      const id = optionalId(row.id);
      if (id === null || names.has(id) || !Number.isSafeInteger(row.sequence)) throw new Error('Niezgodny etap.');
      names.set(id, text(row.name));
      return { id, name: text(row.name), sequence: row.sequence as number };
    });
    const stageName = (id: string | null) => id === null ? stagesSectionMessages.unassigned
      : names.get(id) ?? stagesSectionMessages.deletedStage;
    const currentStageId = optionalId(app.current_stage_id);

    const moveRows = moves.data.slice(0, STAGES_HISTORY_LIMIT).map(item => {
      const row = record(item);
      bound(row, scoped);
      return {
        fromStage: stageName(optionalId(row.from_stage_id)),
        toStage: stageName(optionalId(row.to_stage_id)),
        at: reportTimestamp(row.created_at),
        actor: reportActorLabel(text(optionalId(row.actor_id)), viewer),
      };
    });
    const decisionRows = decisions.data.slice(0, STAGES_HISTORY_LIMIT).map(item => {
      const row = record(item);
      bound(row, scoped);
      return {
        previousDecision: humanDecisionLabel(decisionValue(row.previous_decision, true)),
        newDecision: humanDecisionLabel(decisionValue(row.new_decision, false)),
        reason: text(row.reason),
        at: reportTimestamp(row.created_at),
        actor: reportActorLabel(text(optionalId(row.actor_id)), viewer),
      };
    });
    const current = decisionValue(app.human_decision, true);
    const reason = app.human_decision_reason === null ? null : text(app.human_decision_reason);

    return {
      kind: 'list',
      currentStage: stageName(currentStageId),
      stages: stageList.map(stage => ({ name: stage.name, sequence: stage.sequence, current: stage.id === currentStageId })),
      moves: moveRows,
      movesTruncated: moves.data.length > STAGES_HISTORY_LIMIT,
      decision: current === null ? null : { label: humanDecisionLabel(current), reason },
      decisions: decisionRows,
      decisionsTruncated: decisions.data.length > STAGES_HISTORY_LIMIT,
    };
  } catch {
    return { kind: 'error', message: stagesSectionMessages.error };
  }
}
