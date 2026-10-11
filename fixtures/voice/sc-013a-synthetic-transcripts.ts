/**
 * Fictional SC-013-A transcripts for two companies and two roles.
 * No real candidate, phone number, email address, recording, or provider payload.
 */
const qualityCompany = {
  schemaVersion: 1,
  provenance: "synthetic_fixture",
  untrusted: false,
  contextComplete: true,
  language: "pl-PL",
  companyId: "11111111-1111-4111-8111-111111111111",
  recruitmentId: "11111111-1111-4111-8111-111111111112",
  applicationId: "11111111-1111-4111-8111-111111111113",
  voiceInterviewId: "11111111-1111-4111-8111-111111111114",
  roleKey: "software-quality-specialist",
  roleTitle: "Specjalista jakości oprogramowania",
  planVersionId: "plan-quality-v3",
  planRevision: 4,
  transcriptRevision: 3,
  sourceId: "src-quality-rev3",
  providerEventId: "evt-quality-0003",
  providerCallId: "call-quality-0003",
  attemptId: "11111111-1111-4111-8111-111111111115",
  correlationId: "corr-quality-0003",
  segments: [
    {
      segmentId: "seg-qual-0001",
      speaker: "interviewer",
      startMs: 0,
      endMs: 7000,
      text: "Proszę opisać, jak sprawdzał Pan lub sprawdzała Pani jakość wydania oprogramowania.",
    },
    {
      segmentId: "seg-qual-0002",
      speaker: "candidate",
      startMs: 7000,
      endMs: 19000,
      text: "Prowadziłem listę kontrolną wydania i porównywałem wynik testów z kryteriami akceptacji przed publikacją.",
    },
    {
      segmentId: "seg-qual-0003",
      speaker: "interviewer",
      startMs: 19000,
      endMs: 24000,
      text: "Jaki był konkretny rezultat tej kontroli?",
    },
    {
      segmentId: "seg-qual-0004",
      speaker: "candidate",
      startMs: 24000,
      endMs: 38000,
      text: "Znalazłem rozbieżność między raportem testów a kryteriami i wstrzymałem publikację do czasu poprawki 👍.",
    },
  ],
} as const;

const warehouseCompany = {
  schemaVersion: 1,
  provenance: "synthetic_fixture",
  untrusted: false,
  contextComplete: true,
  language: "pl-PL",
  companyId: "22222222-2222-4222-8222-222222222222",
  recruitmentId: "22222222-2222-4222-8222-222222222223",
  applicationId: "22222222-2222-4222-8222-222222222224",
  voiceInterviewId: "22222222-2222-4222-8222-222222222225",
  roleKey: "warehouse-shift-coordinator",
  roleTitle: "Koordynator zmiany magazynowej",
  planVersionId: "plan-warehouse-v2",
  planRevision: 2,
  transcriptRevision: 3,
  sourceId: "src-warehouse-rev3",
  providerEventId: "evt-warehouse-003",
  providerCallId: "call-warehouse-003",
  attemptId: "22222222-2222-4222-8222-222222222226",
  correlationId: "corr-warehouse-003",
  segments: [
    {
      segmentId: "seg-ware-0001",
      speaker: "interviewer",
      startMs: 0,
      endMs: 8000,
      text: "Proszę opisać, jak ustalał Pan lub ustalała Pani kolejność pracy zmiany w magazynie.",
    },
    {
      segmentId: "seg-ware-0002",
      speaker: "candidate",
      startMs: 8000,
      endMs: 21000,
      text: "Ustalałem kolejność kompletacji według terminów wysyłki i sprawdzałem stany przed startem zmiany.",
    },
    {
      segmentId: "seg-ware-0003",
      speaker: "interviewer",
      startMs: 21000,
      endMs: 26000,
      text: "Jak mierzył Pan lub mierzyła Pani wynik zmiany?",
    },
    {
      segmentId: "seg-ware-0004",
      speaker: "candidate",
      startMs: 26000,
      endMs: 40000,
      text: "Porównywałem liczbę zrealizowanych zleceń z planem zmiany i wyjaśniałem braki na koniec dnia.",
    },
  ],
} as const;

export function qualityCompanyTranscript() {
  return structuredClone(qualityCompany);
}

export function warehouseCompanyTranscript() {
  return structuredClone(warehouseCompany);
}

export const qualityQuotes = Object.freeze({
  checklist: "Prowadziłem listę kontrolną wydania i porównywałem wynik testów z kryteriami akceptacji przed publikacją.",
  releaseHold: "wstrzymałem publikację do czasu poprawki 👍",
});

export const warehouseQuotes = Object.freeze({
  sequence: "Ustalałem kolejność kompletacji według terminów wysyłki i sprawdzałem stany przed startem zmiany.",
  plan: "Porównywałem liczbę zrealizowanych zleceń z planem zmiany i wyjaśniałem braki na koniec dnia.",
});
