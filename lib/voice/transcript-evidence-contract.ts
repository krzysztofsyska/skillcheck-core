/**
 * SC-013-A offline synthetic transcript and evidence contract.
 * Fictional fixtures only. This module does not authenticate a provider,
 * does not accept a raw provider event as evidence, does not store media,
 * and does not emit a hire or reject decision.
 * `authenticated` is always false. `insufficient_data` keeps numericScore null.
 */
import { createHash } from "node:crypto";
import { behaviorGuideDefinitions } from "../behavior-guide.ts";

export const SC013A_CONTRACT = "sc-013a-synthetic-transcript-v1";
export const TRANSCRIPT_CANONICALIZATION = "rfc8785-transcript-v1";

export const transcriptEvidenceCodes = [
  "invalid_transcript",
  "missing_source",
  "impossible_timestamp",
  "speaker_mismatch",
  "revision_mismatch",
  "invented_quotation",
  "truncated_context",
  "pii_leakage",
  "untrusted_source",
  "cross_tenant",
  "out_of_order",
  "stale_source",
  "idempotency_conflict",
  "prohibited_decision",
  "absence_scored_as_zero",
  "insufficient_evidence",
  "conflict",
] as const;
export type TranscriptEvidenceCode = typeof transcriptEvidenceCodes[number];

export class TranscriptEvidenceError extends Error {
  readonly code: TranscriptEvidenceCode;
  constructor(code: TranscriptEvidenceCode) {
    super(code);
    this.name = "TranscriptEvidenceError";
    this.code = code;
  }
}

export const speakerRoles = ["interviewer", "candidate"] as const;
export type SpeakerRole = typeof speakerRoles[number];
export const ratingScale = ["insufficient_data", "below", "meets", "above"] as const;
export type CriterionRating = typeof ratingScale[number];
export const criterionKinds = ["task", "kpi", "competency", "behavior"] as const;
export type CriterionKind = typeof criterionKinds[number];
export const assessmentValidityScale = [
  "approved",
  "approved_with_changes",
  "requires_follow_up",
  "rejected_result",
] as const;
export type AssessmentValidity = typeof assessmentValidityScale[number];
export type ApprovingValidity = "approved" | "approved_with_changes";

/** Frozen input shape. A raw provider event is not a member of this schema. */
export const transcriptEventFields = Object.freeze([
  "schemaVersion", "provenance", "untrusted", "contextComplete", "language",
  "companyId", "recruitmentId", "applicationId", "voiceInterviewId",
  "roleKey", "roleTitle", "planVersionId", "planRevision", "planCriteria", "transcriptRevision",
  "sourceId", "providerEventId", "providerCallId", "attemptId", "correlationId",
  "segments",
] as const);
export const evidenceSpanFields = Object.freeze([
  "segmentId", "startUtf16", "endUtf16", "quote",
] as const);
export const reviewerOverrideFields = Object.freeze([
  "schemaVersion", "idempotencyKey", "reviewerId", "reviewedAt", "analysisId",
  "expectedAnalysisVersion", "expectedTranscriptSha256", "expectedSourceFingerprint",
  "expectedReviewVersion", "expectedPointerVersion", "expectedCurrentAnalysisId",
  "expectedLineageVersion", "assessmentValidity", "rationale", "overrides",
] as const);

const sealedByModule = new WeakSet<object>();
const draftsByModule = new WeakSet<object>();
const ledgersByModule = new WeakSet<object>();
const MAX_MS = 600_000;
const MAX_INPUT = 65_536;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const roleKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+){1,8}$/;
const criterionIdPattern = /^(task|kpi|competency|behavior):([1-9]\d?)$/;
const behaviorAreaIds: ReadonlySet<string> = new Set<string>(behaviorGuideDefinitions.map(area => area.id));
const evidenceAlphanumeric = new RegExp('[\\p{L}\\p{N}]', 'u');
const sourceIdentity = new Set([
  "companyId", "recruitmentId", "applicationId", "voiceInterviewId", "sourceId",
  "providerEventId", "providerCallId", "attemptId", "correlationId", "planVersionId",
  "planRevision", "transcriptRevision", "provenance", "untrusted",
]);
const decisionKeys = new Set([
  "hire", "reject", "shortlist", "hiredecision", "autodecision", "candidatedecision", "decision",
]);
const piiKeys = new Set([
  "email", "phone", "candidatename", "rawcv", "cvtext", "pesel", "recordingurl", "audiourl",
]);

export type SealedSegment = Readonly<{
  segmentId: string;
  speaker: SpeakerRole;
  startMs: number;
  endMs: number;
  text: string;
}>;
export type EvidenceSpan = Readonly<{
  segmentId: string;
  speaker: "candidate";
  startUtf16: number;
  endUtf16: number;
  quote: string;
}>;
export type CriterionResult = Readonly<{
  criterionId: string;
  kind: CriterionKind;
  rubricVersion: string;
  rating: CriterionRating;
  numericScore: null;
  evidence: readonly EvidenceSpan[];
  rationale: string;
}>;
export type SealedTranscript = Readonly<{
  schemaVersion: 1;
  contract: typeof SC013A_CONTRACT;
  canonicalization: typeof TRANSCRIPT_CANONICALIZATION;
  evidenceTrust: "synthetic_fixture";
  authenticated: false;
  productionEvidence: false;
  provenance: "synthetic_fixture";
  untrusted: false;
  contextComplete: true;
  language: "pl-PL";
  companyId: string;
  recruitmentId: string;
  applicationId: string;
  voiceInterviewId: string;
  roleKey: string;
  roleTitle: string;
  planVersionId: string;
  planRevision: number;
  planCriteria: readonly FrozenCriterion[];
  transcriptRevision: number;
  sourceId: string;
  providerEventId: string;
  providerCallId: string;
  attemptId: string;
  correlationId: string;
  canonicalTranscriptJson: string;
  transcriptSha256: string;
  sourceFingerprint: string;
  segments: readonly SealedSegment[];
}>;
export type AssessmentDraft = Readonly<{
  schemaVersion: 1;
  evidenceTrust: "synthetic_fixture";
  authenticated: false;
  productionEvidence: false;
  hireDecision: null;
  companyId: string;
  voiceInterviewId: string;
  roleKey: string;
  sourceId: string;
  planVersionId: string;
  planRevision: number;
  transcriptRevision: number;
  transcriptSha256: string;
  sourceFingerprint: string;
  idempotencyKey: string;
  criteria: readonly CriterionResult[];
  fingerprint: string;
}>;
export type StoredReview = Readonly<{
  assessmentValidity: AssessmentValidity;
  reviewerId: string;
  reviewedAt: string;
  rationale: string;
  overrides: readonly CriterionResult[];
  fingerprint: string;
}>;
export type StoredAnalysis = Readonly<{
  analysisId: string;
  analysisVersion: number;
  idempotencyKey: string;
  fingerprint: string;
  transcriptSha256: string;
  sourceFingerprint: string;
  transcriptRevision: number;
  planRevision: number;
  criteria: readonly CriterionResult[];
  reviewVersion: number;
  review: StoredReview | null;
  superseded: boolean;
}>;
export type EvidenceLedger = Readonly<{
  schemaVersion: 1;
  companyId: string;
  recruitmentId: string;
  applicationId: string;
  voiceInterviewId: string;
  roleKey: string;
  sourceId: string;
  attemptId: string;
  providerCallId: string;
  planVersionId: string;
  planRevision: number;
  planCriteria: readonly FrozenCriterion[];
  transcriptRevision: number;
  transcriptSha256: string;
  sourceFingerprint: string;
  lineageVersion: number;
  pointerVersion: number;
  currentAnalysisId: string | null;
  analyses: readonly StoredAnalysis[];
  idempotency: Readonly<Record<string, string>>;
  reviewIdempotency: Readonly<Record<string, string>>;
}>;
export type LedgerOutcome =
  | "applied"
  | "duplicate"
  | "out_of_order"
  | "stale_source"
  | "cross_tenant"
  | "conflict"
  | "idempotency_conflict"
  | "revision_mismatch";
export type LedgerResult = Readonly<{
  ledger: EvidenceLedger;
  outcome: LedgerOutcome;
  analysisId: string | null;
}>;
export type EffectiveResult = Readonly<{
  state: "current" | "none" | "stale" | "withheld";
  reason: "unreviewed" | AssessmentValidity | null;
  productionEvidence: false;
  authenticated: false;
  hireDecision: null;
  evidenceTrust: "synthetic_fixture" | null;
  analysisId: string | null;
  analysisVersion: number | null;
  pointerVersion: number;
  criteria: readonly CriterionResult[] | null;
}>;

type Canon = null | boolean | number | string | Canon[] | { [key: string]: Canon };
type FrozenCriterion = Readonly<{ criterionId: string; kind: CriterionKind; rubricVersion: string }>;

function reject(code: TranscriptEvidenceCode): never {
  throw new TranscriptEvidenceError(code);
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function ownNames(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) reject("invalid_transcript");
  return keys as string[];
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  const actual = ownNames(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}
function denseArray(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  if (Object.keys(value).length !== value.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return false;
  }
  return Reflect.ownKeys(value).every(key => typeof key === "string" && (key === "length" || /^\d+$/.test(key)));
}
function assertWellFormed(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject("truncated_context");
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      reject("truncated_context");
    }
  }
}
function utf16Boundary(text: string, index: number): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index > text.length) return false;
  if (index === 0 || index === text.length) return true;
  const prev = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return !(prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
function hasPii(text: string): boolean {
  if (text.includes("@")) return true;
  // Defense-in-depth only: production transcripts still require separate PII minimization.
  if (/(?:^|[^A-Za-z0-9])\+(?:\d[\s()./-]*){8,15}(?!\d)/.test(text)) return true;
  // 00 is the same international prefix as +, including a space after 00.
  if (/(?:^|[^A-Za-z0-9])00(?:[\s()./-]*\d){8,15}(?!\d)/.test(text)) return true;
  // Recognize Polish IBAN (26 digits after PL), including bank-style grouping.
  if (/(?:^|[^A-Za-z0-9])PL[ -]?\d{2}(?:[ -]?\d{4}){6}(?!\d)/i.test(text)) return true;
  return /(?:^|[^\d])\+\d{8,15}(?!\d)/.test(text) ||
    // Polish nine-digit numbers, with dots, slashes, brackets or whitespace.
    /(?:^|[^\d])(?:\+48[\s()./-]*)?(?:\(?\d{3}\)?[\s./-]*){2}\d{3}(?!\d)/.test(text) ||
    /(?:^|\D)(?:\d{3}[\s-]){2}\d{3}(?!\d)/.test(text) ||
    /(?:^|\D)\d{11}(?!\d)/.test(text) ||
    /(?:^|\D)\d{9}(?!\d)/.test(text) ||
    /\b(?:pesel|iban)\b/i.test(text);
}
function jcsString(value: string): string {
  assertWellFormed(value);
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += value[i];
  }
  return `${out}"`;
}
function asCanon(value: unknown, depth = 0): Canon {
  if (depth > 12) reject("invalid_transcript");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) reject("invalid_transcript");
    return value;
  }
  if (Array.isArray(value)) {
    if (!denseArray(value, 0, 1000)) reject("invalid_transcript");
    return value.map(item => asCanon(item, depth + 1));
  }
  if (!plainObject(value)) reject("invalid_transcript");
  // A normal object assignment treats "__proto__" as the legacy setter.
  const out = Object.create(null) as { [key: string]: Canon };
  for (const key of ownNames(value)) {
    Object.defineProperty(out, key, {
      value: asCanon(value[key], depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
function canonicalize(value: Canon): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return jcsString(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${jcsString(key)}:${canonicalize(value[key]!)}`).join(",")}}`;
}
export function rfc8785Canonicalize(value: unknown): string {
  return canonicalize(asCanon(value));
}
export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function transcriptDocument(segments: readonly SealedSegment[]): Canon {
  return {
    schema_version: 1,
    segments: segments.map(segment => ({
      end_ms: segment.endMs,
      segment_id: segment.segmentId,
      speaker: segment.speaker,
      start_ms: segment.startMs,
      text: segment.text,
    })),
  };
}
function foldKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}
function walkKeys(value: unknown, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, depth + 1);
    return;
  }
  for (const key of ownNames(value)) {
    const folded = foldKey(key);
    if (decisionKeys.has(folded)) reject("prohibited_decision");
    if (piiKeys.has(folded)) reject("pii_leakage");
    walkKeys((value as Record<string, unknown>)[key], depth + 1);
  }
}
function looksLikeProviderEvent(value: unknown): boolean {
  if (!plainObject(value)) return false;
  const names = ownNames(value);
  return names.includes("status") && names.includes("eventId") && !names.includes("segments");
}
function safeText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) reject("invalid_transcript");
  if (/[\u0000-\u001f\u007f]/.test(value)) reject("invalid_transcript");
  assertWellFormed(value);
  if (hasPii(value)) reject("pii_leakage");
  return value;
}
function requireRevision(value: unknown): number {
  if (value === undefined || value === null || value === "") reject("missing_source");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    reject("invalid_transcript");
  }
  return value;
}
function requireIdentity(value: unknown, kind: "uuid" | "opaque"): string {
  if (typeof value !== "string" || value.trim() === "") reject("missing_source");
  if (kind === "uuid" ? !uuid.test(value) : !opaque.test(value)) reject("invalid_transcript");
  return value;
}
function truncatedText(text: string): boolean {
  const normalized = text.trimEnd().toLowerCase();
  return normalized.endsWith("...") || normalized.endsWith("…") ||
    normalized.endsWith("[truncated]") || normalized.endsWith("[uciete]") || normalized.endsWith("[ucięte]");
}
function ownBinding(record: Readonly<Record<string, string>>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function parseUntrustedJson(text: string): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_INPUT) reject("invalid_transcript");
  if (text.charCodeAt(0) === 0xfeff) reject("invalid_transcript");
  let index = 0;
  const value = parseValue(0);
  skip();
  if (index !== text.length) reject("invalid_transcript");
  return value;

  function parseValue(depth: number): unknown {
    if (depth > 12) reject("invalid_transcript");
    skip();
    const mark = text[index];
    if (mark === "{") return parseObject(depth);
    if (mark === "[") return parseArray(depth);
    if (mark === '"') return parseString();
    if (mark === "t") return literal("true", true);
    if (mark === "f") return literal("false", false);
    if (mark === "n") return literal("null", null);
    if (mark !== undefined && mark >= "0" && mark <= "9") return parseNumber();
    reject("invalid_transcript");
  }
  function skip(): void {
    while (index < text.length) {
      const mark = text[index];
      if (mark !== " " && mark !== "\n" && mark !== "\r" && mark !== "\t") break;
      index += 1;
    }
  }
  function literal(token: string, value: unknown): unknown {
    if (text.slice(index, index + token.length) !== token) reject("invalid_transcript");
    index += token.length;
    return value;
  }
  function parseNumber(): number {
    const start = index;
    if (text[index] === "0") index += 1;
    else {
      if (!(text[index]! >= "1" && text[index]! <= "9")) reject("invalid_transcript");
      while (index < text.length && text[index]! >= "0" && text[index]! <= "9") index += 1;
    }
    const next = text[index];
    if (next === "." || next === "e" || next === "E" || next === "+" || next === "-") reject("invalid_transcript");
    if (text[start] === "0" && index > start + 1) reject("invalid_transcript");
    const raw = text.slice(start, index);
    if (raw.length > 15) reject("invalid_transcript");
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) reject("invalid_transcript");
    return parsed;
  }
  function parseString(): string {
    index += 1;
    let out = "";
    while (index < text.length) {
      const mark = text[index];
      if (mark === '"') {
        index += 1;
        assertWellFormed(out);
        return out;
      }
      if (mark === "\\") {
        index += 1;
        const escaped = text[index++];
        if (escaped === '"' || escaped === "\\" || escaped === "/") out += escaped;
        else if (escaped === "b") out += "\b";
        else if (escaped === "f") out += "\f";
        else if (escaped === "n") out += "\n";
        else if (escaped === "r") out += "\r";
        else if (escaped === "t") out += "\t";
        else if (escaped === "u") {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) reject("invalid_transcript");
          index += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
        } else reject("invalid_transcript");
        continue;
      }
      if (mark === undefined || mark < " ") reject("invalid_transcript");
      out += mark;
      index += 1;
    }
    reject("invalid_transcript");
  }
  function parseArray(depth: number): unknown[] {
    index += 1;
    const items: unknown[] = [];
    skip();
    if (text[index] === "]") {
      index += 1;
      return items;
    }
    while (index < text.length) {
      items.push(parseValue(depth + 1));
      skip();
      if (text[index] === "]") {
        index += 1;
        return items;
      }
      if (text[index] !== ",") reject("invalid_transcript");
      index += 1;
    }
    reject("invalid_transcript");
  }
  function parseObject(depth: number): Record<string, unknown> {
    index += 1;
    const out: Record<string, unknown> = {};
    skip();
    if (text[index] === "}") {
      index += 1;
      return out;
    }
    while (index < text.length) {
      skip();
      if (text[index] !== '"') reject("invalid_transcript");
      const key = parseString();
      if (key === "__proto__" || key === "constructor" || key === "prototype") reject("invalid_transcript");
      if (Object.prototype.hasOwnProperty.call(out, key)) reject("invalid_transcript");
      skip();
      if (text[index] !== ":") reject("invalid_transcript");
      index += 1;
      Object.defineProperty(out, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
      skip();
      if (text[index] === "}") {
        index += 1;
        return out;
      }
      if (text[index] !== ",") reject("invalid_transcript");
      index += 1;
    }
    reject("invalid_transcript");
  }
}

function freezeSegment(segment: SealedSegment): SealedSegment {
  return Object.freeze({ ...segment });
}
function freezeSpan(span: EvidenceSpan): EvidenceSpan {
  return Object.freeze({ ...span });
}
function freezeCriterion(result: CriterionResult): CriterionResult {
  return Object.freeze({ ...result, evidence: Object.freeze(result.evidence.map(freezeSpan)) });
}

export function sealSyntheticTranscript(input: unknown): SealedTranscript {
  const parsed = typeof input === "string" ? parseUntrustedJson(input) : input;
  if (looksLikeProviderEvent(parsed)) reject("untrusted_source");
  let cloned: unknown;
  try {
    cloned = structuredClone(parsed);
  } catch {
    reject("invalid_transcript");
  }
  let encoded = "";
  try {
    encoded = JSON.stringify(cloned);
  } catch {
    reject("invalid_transcript");
  }
  if (!encoded || encoded.length > MAX_INPUT) reject("invalid_transcript");
  if (looksLikeProviderEvent(cloned)) reject("untrusted_source");
  walkKeys(cloned);
  if (!plainObject(cloned)) reject("invalid_transcript");
  const names = ownNames(cloned);
  sourceIdentity.forEach(key => {
    if (!names.includes(key)) reject("missing_source");
  });
  if (!exactKeys(cloned, transcriptEventFields)) reject("invalid_transcript");

  if (cloned.schemaVersion !== 1) reject("invalid_transcript");
  if (cloned.language !== "pl-PL") reject("invalid_transcript");
  if (typeof cloned.contextComplete !== "boolean") reject("invalid_transcript");
  if (cloned.contextComplete !== true) reject("truncated_context");
  if (cloned.provenance !== "synthetic_fixture" || cloned.untrusted !== false) reject("untrusted_source");

  const companyId = requireIdentity(cloned.companyId, "uuid");
  const recruitmentId = requireIdentity(cloned.recruitmentId, "uuid");
  const applicationId = requireIdentity(cloned.applicationId, "uuid");
  const voiceInterviewId = requireIdentity(cloned.voiceInterviewId, "uuid");
  const attemptId = requireIdentity(cloned.attemptId, "uuid");
  const sourceId = requireIdentity(cloned.sourceId, "opaque");
  const providerEventId = requireIdentity(cloned.providerEventId, "opaque");
  const providerCallId = requireIdentity(cloned.providerCallId, "opaque");
  const correlationId = requireIdentity(cloned.correlationId, "opaque");
  const planVersionId = requireIdentity(cloned.planVersionId, "opaque");
  const planRevision = requireRevision(cloned.planRevision);
  const planCriteria = Object.freeze(readPlanCriteria(cloned.planCriteria).map(freezePlanCriterion));
  const transcriptRevision = requireRevision(cloned.transcriptRevision);
  if (typeof cloned.roleKey !== "string" || !roleKeyPattern.test(cloned.roleKey)) reject("invalid_transcript");
  if (typeof cloned.roleTitle !== "string") reject("invalid_transcript");
  const roleTitle = safeText(cloned.roleTitle.trim(), 1, 200);
  if (!denseArray(cloned.segments, 2, 30)) reject("invalid_transcript");

  const seen = new Set<string>();
  let interviewer = 0;
  let candidate = 0;
  const segments: SealedSegment[] = [];
  for (const item of cloned.segments) {
    if (!exactKeys(item, ["segmentId", "speaker", "startMs", "endMs", "text"])) reject("invalid_transcript");
    const segmentId = requireIdentity(item.segmentId, "opaque");
    if (seen.has(segmentId)) reject("conflict");
    seen.add(segmentId);
    if (item.speaker !== "interviewer" && item.speaker !== "candidate") reject("speaker_mismatch");
    const speaker: SpeakerRole = item.speaker === "candidate" ? "candidate" : "interviewer";
    if (speaker === "interviewer") interviewer += 1;
    else candidate += 1;
    if (typeof item.startMs !== "number" || typeof item.endMs !== "number" ||
      !Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) ||
      item.startMs < 0 || item.endMs > MAX_MS || item.endMs <= item.startMs) {
      reject("impossible_timestamp");
    }
    const previous = segments[segments.length - 1];
    if (previous && item.startMs < previous.startMs) reject("out_of_order");
    if (previous && item.startMs < previous.endMs) reject("impossible_timestamp");
    const text = safeText(item.text, 1, 500);
    if (truncatedText(text)) reject("truncated_context");
    segments.push({ segmentId, speaker, startMs: item.startMs, endMs: item.endMs, text });
  }
  if (interviewer < 1 || candidate < 1) reject("speaker_mismatch");

  const canonicalTranscriptJson = canonicalize(transcriptDocument(segments));
  const transcriptSha256 = sha256Utf8(canonicalTranscriptJson);
  const sourceFingerprint = sha256Utf8(canonicalize({
    algorithm: TRANSCRIPT_CANONICALIZATION,
    application_id: applicationId,
    attempt_id: attemptId,
    company_id: companyId,
    context_complete: true,
    correlation_id: correlationId,
    language: "pl-PL",
    plan_criteria: planCriteria.map(item => ({
      criterion_id: item.criterionId,
      kind: item.kind,
      rubric_version: item.rubricVersion,
    })),
    plan_revision: planRevision,
    plan_version_id: planVersionId,
    provenance: "synthetic_fixture",
    provider_call_id: providerCallId,
    provider_event_id: providerEventId,
    recruitment_id: recruitmentId,
    role_key: cloned.roleKey,
    schema_version: 1,
    source_id: sourceId,
    transcript_revision: transcriptRevision,
    transcript_sha256: transcriptSha256,
    untrusted: false,
    voice_interview_id: voiceInterviewId,
  }));
  const sealed: SealedTranscript = Object.freeze({
    schemaVersion: 1,
    contract: SC013A_CONTRACT,
    canonicalization: TRANSCRIPT_CANONICALIZATION,
    evidenceTrust: "synthetic_fixture",
    authenticated: false,
    productionEvidence: false,
    provenance: "synthetic_fixture",
    untrusted: false,
    contextComplete: true,
    language: "pl-PL",
    companyId,
    recruitmentId,
    applicationId,
    voiceInterviewId,
    roleKey: cloned.roleKey,
    roleTitle,
    planVersionId,
    planRevision,
    planCriteria,
    transcriptRevision,
    sourceId,
    providerEventId,
    providerCallId,
    attemptId,
    correlationId,
    canonicalTranscriptJson,
    transcriptSha256,
    sourceFingerprint,
    segments: Object.freeze(segments.map(freezeSegment)),
  });
  sealedByModule.add(sealed);
  return sealed;
}

function requireSealed(value: SealedTranscript): SealedTranscript {
  if (!sealedByModule.has(value) || value.authenticated !== false || value.productionEvidence !== false ||
    value.evidenceTrust !== "synthetic_fixture") reject("untrusted_source");
  return value;
}
function bindingMismatch(sealed: SealedTranscript, request: Record<string, unknown>): void {
  if (request.companyId !== sealed.companyId || request.voiceInterviewId !== sealed.voiceInterviewId) {
    reject("cross_tenant");
  }
  if (request.transcriptSha256 !== sealed.transcriptSha256 || request.sourceFingerprint !== sealed.sourceFingerprint) {
    reject("stale_source");
  }
  if (request.sourceId !== sealed.sourceId || request.planVersionId !== sealed.planVersionId ||
    request.planRevision !== sealed.planRevision || request.transcriptRevision !== sealed.transcriptRevision) {
    reject("revision_mismatch");
  }
}
function readCriterion(value: unknown): FrozenCriterion {
  if (!exactKeys(value, ["criterionId", "kind", "rubricVersion"])) reject("invalid_transcript");
  if (typeof value.kind !== "string" || !criterionKinds.includes(value.kind as CriterionKind)) reject("invalid_transcript");
  if (typeof value.criterionId !== "string") reject("invalid_transcript");
  if (value.kind === "behavior" && behaviorAreaIds.has(value.criterionId)) {
    // SC-012 emits canonical area IDs, not behavior:1; keep the legacy v1
    // behavior:n shape for existing isolated rubric fixtures.
  } else if (!criterionIdPattern.test(value.criterionId) ||
      !value.criterionId.startsWith(`${value.kind}:`)) {
    reject("invalid_transcript");
  }
  if (typeof value.rubricVersion !== "string" || value.rubricVersion.length > 64 || !opaque.test(value.rubricVersion)) {
    reject("invalid_transcript");
  }
  return { criterionId: value.criterionId, kind: value.kind as CriterionKind, rubricVersion: value.rubricVersion };
}
function readPlanCriteria(value: unknown): FrozenCriterion[] {
  if (!denseArray(value, 1, 12)) reject("invalid_transcript");
  const criteria = value.map(readCriterion);
  const ids = new Set<string>();
  for (const item of criteria) {
    if (ids.has(item.criterionId)) reject("invalid_transcript");
    ids.add(item.criterionId);
  }
  return criteria;
}
function freezePlanCriterion(item: FrozenCriterion): FrozenCriterion {
  return Object.freeze({
    criterionId: item.criterionId,
    kind: item.kind,
    rubricVersion: item.rubricVersion,
  });
}
function samePlanRoster(left: readonly FrozenCriterion[], right: readonly FrozenCriterion[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return !!other && item.criterionId === other.criterionId &&
      item.kind === other.kind && item.rubricVersion === other.rubricVersion;
  });
}
function sameCriterionSet(left: readonly FrozenCriterion[], right: readonly FrozenCriterion[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(item => right.some(other =>
    other.criterionId === item.criterionId &&
    other.kind === item.kind &&
    other.rubricVersion === item.rubricVersion));
}
function validateEvidence(sealed: SealedTranscript, evidence: unknown, rating: CriterionRating): EvidenceSpan[] {
  if (!denseArray(evidence, 0, 5)) reject("insufficient_evidence");
  if (rating === "insufficient_data") {
    if (evidence.length !== 0) reject("insufficient_evidence");
    return [];
  }
  if (evidence.length < 1) reject("insufficient_evidence");
  return evidence.map(item => {
    if (!exactKeys(item, evidenceSpanFields)) reject("invalid_transcript");
    if (typeof item.segmentId !== "string" || !opaque.test(item.segmentId)) reject("invented_quotation");
    const segment = sealed.segments.find(candidate => candidate.segmentId === item.segmentId);
    if (!segment) reject("invented_quotation");
    if (segment.speaker !== "candidate") reject("speaker_mismatch");
    if (typeof item.startUtf16 !== "number" || typeof item.endUtf16 !== "number" ||
      !Number.isSafeInteger(item.startUtf16) || !Number.isSafeInteger(item.endUtf16)) {
      reject("invalid_transcript");
    }
    if (item.startUtf16 < 0 || item.endUtf16 > segment.text.length || item.endUtf16 <= item.startUtf16) {
      reject("invented_quotation");
    }
    if (!utf16Boundary(segment.text, item.startUtf16) || !utf16Boundary(segment.text, item.endUtf16)) {
      reject("truncated_context");
    }
    if (typeof item.quote !== "string" || item.quote.length > 240 || item.quote.trim() === "") {
      reject("invented_quotation");
    }
    // A one-character substring may be exact but is not substantive evidence.
    if (Array.from(item.quote).filter(char => evidenceAlphanumeric.test(char)).length < 8) {
      reject("insufficient_evidence");
    }
    assertWellFormed(item.quote);
    if (hasPii(item.quote)) reject("pii_leakage");
    if (segment.text.slice(item.startUtf16, item.endUtf16) !== item.quote) reject("invented_quotation");
    return freezeSpan({
      segmentId: segment.segmentId,
      speaker: "candidate",
      startUtf16: item.startUtf16,
      endUtf16: item.endUtf16,
      quote: item.quote,
    });
  });
}
function validateRating(sealed: SealedTranscript, criterion: FrozenCriterion, value: unknown): CriterionResult {
  if (!plainObject(value)) reject("invalid_transcript");
  if ("numericScore" in value) {
    if (value.rating === "insufficient_data" || value.numericScore === 0) reject("absence_scored_as_zero");
    reject("prohibited_decision");
  }
  if (!exactKeys(value, ["criterionId", "rating", "evidence", "rationale"])) reject("invalid_transcript");
  if (value.criterionId !== criterion.criterionId) reject("invalid_transcript");
  if (typeof value.rating !== "string" || !ratingScale.includes(value.rating as CriterionRating)) {
    reject("invalid_transcript");
  }
  const rating = value.rating as CriterionRating;
  const rationale = safeText(value.rationale, 1, 500);
  return freezeCriterion({
    criterionId: criterion.criterionId,
    kind: criterion.kind,
    rubricVersion: criterion.rubricVersion,
    rating,
    numericScore: null,
    evidence: Object.freeze(validateEvidence(sealed, value.evidence, rating)),
    rationale,
  });
}
function assessmentFingerprint(sealed: SealedTranscript, criteria: readonly CriterionResult[]): string {
  return sha256Utf8(canonicalize({
    criteria: criteria.map(item => ({
      criterion_id: item.criterionId,
      evidence: item.evidence.map(span => ({
        end_utf16: span.endUtf16,
        quote: span.quote,
        segment_id: span.segmentId,
        start_utf16: span.startUtf16,
      })),
      kind: item.kind,
      numeric_score: null,
      rating: item.rating,
      rationale: item.rationale,
      rubric_version: item.rubricVersion,
    })),
    schema_version: 1,
    source_fingerprint: sealed.sourceFingerprint,
    transcript_sha256: sealed.transcriptSha256,
  }));
}

export function assessSyntheticTranscript(sealedInput: SealedTranscript, requestInput: unknown): AssessmentDraft {
  const sealed = requireSealed(sealedInput);
  let cloned: unknown;
  try {
    cloned = structuredClone(requestInput);
  } catch {
    reject("invalid_transcript");
  }
  walkKeys(cloned);
  if (!exactKeys(cloned, [
    "schemaVersion", "companyId", "voiceInterviewId", "sourceId", "planVersionId",
    "planRevision", "transcriptRevision", "transcriptSha256", "sourceFingerprint",
    "idempotencyKey", "criteria", "ratings",
  ])) reject("invalid_transcript");
  if (cloned.schemaVersion !== 1) reject("invalid_transcript");
  bindingMismatch(sealed, cloned);
  const idempotencyKey = requireIdentity(cloned.idempotencyKey, "opaque");
  if (!denseArray(cloned.criteria, 1, 12) || !denseArray(cloned.ratings, 1, 12)) reject("invalid_transcript");
  const criteria = cloned.criteria.map(readCriterion);
  const ids = new Set(criteria.map(item => item.criterionId));
  if (ids.size !== criteria.length) reject("invalid_transcript");
  if (!sameCriterionSet(criteria, sealed.planCriteria)) reject("revision_mismatch");
  if (cloned.ratings.length !== criteria.length) reject("invalid_transcript");
  const used = new Set<string>();
  const byId = new Map<string, unknown>();
  for (const rating of cloned.ratings) {
    if (!plainObject(rating) || typeof rating.criterionId !== "string") reject("invalid_transcript");
    if (used.has(rating.criterionId) || !ids.has(rating.criterionId)) reject("invalid_transcript");
    used.add(rating.criterionId);
    byId.set(rating.criterionId, rating);
  }
  const results = criteria.map(criterion => validateRating(sealed, criterion, byId.get(criterion.criterionId)));
  const draft: AssessmentDraft = Object.freeze({
    schemaVersion: 1,
    evidenceTrust: "synthetic_fixture",
    authenticated: false,
    productionEvidence: false,
    hireDecision: null,
    companyId: sealed.companyId,
    voiceInterviewId: sealed.voiceInterviewId,
    roleKey: sealed.roleKey,
    sourceId: sealed.sourceId,
    planVersionId: sealed.planVersionId,
    planRevision: sealed.planRevision,
    transcriptRevision: sealed.transcriptRevision,
    transcriptSha256: sealed.transcriptSha256,
    sourceFingerprint: sealed.sourceFingerprint,
    idempotencyKey,
    criteria: Object.freeze(results),
    fingerprint: assessmentFingerprint(sealed, results),
  });
  draftsByModule.add(draft);
  return draft;
}

function freezeLedger(ledger: EvidenceLedger): EvidenceLedger {
  const frozen = Object.freeze({
    ...ledger,
    analyses: Object.freeze(ledger.analyses.map(item => Object.freeze({
      ...item,
      criteria: Object.freeze(item.criteria.map(freezeCriterion)),
      review: item.review ? Object.freeze({
        ...item.review,
        overrides: Object.freeze(item.review.overrides.map(freezeCriterion)),
      }) : null,
    }))),
    planCriteria: Object.freeze(ledger.planCriteria.map(freezePlanCriterion)),
    idempotency: Object.freeze({ ...ledger.idempotency }),
    reviewIdempotency: Object.freeze({ ...ledger.reviewIdempotency }),
  });
  ledgersByModule.add(frozen);
  return frozen;
}
function held(ledger: EvidenceLedger, outcome: LedgerOutcome, analysisId: string | null = null): LedgerResult {
  return Object.freeze({ ledger, outcome, analysisId });
}
function requireLedger(ledger: EvidenceLedger): EvidenceLedger {
  if (!ledgersByModule.has(ledger)) reject("untrusted_source");
  return ledger;
}
function requireDraft(draft: AssessmentDraft): AssessmentDraft {
  if (!draftsByModule.has(draft) || draft.authenticated !== false || draft.hireDecision !== null ||
    draft.productionEvidence !== false) reject("untrusted_source");
  return draft;
}

export function openEvidenceLedger(sealedInput: SealedTranscript): EvidenceLedger {
  const sealed = requireSealed(sealedInput);
  return freezeLedger({
    schemaVersion: 1,
    companyId: sealed.companyId,
    recruitmentId: sealed.recruitmentId,
    applicationId: sealed.applicationId,
    voiceInterviewId: sealed.voiceInterviewId,
    roleKey: sealed.roleKey,
    sourceId: sealed.sourceId,
    attemptId: sealed.attemptId,
    providerCallId: sealed.providerCallId,
    planVersionId: sealed.planVersionId,
    planRevision: sealed.planRevision,
    planCriteria: sealed.planCriteria,
    transcriptRevision: sealed.transcriptRevision,
    transcriptSha256: sealed.transcriptSha256,
    sourceFingerprint: sealed.sourceFingerprint,
    lineageVersion: 0,
    pointerVersion: 0,
    currentAnalysisId: null,
    analyses: [],
    idempotency: {},
    reviewIdempotency: {},
  });
}

export function recordTranscriptRevision(ledgerInput: EvidenceLedger, sealedInput: SealedTranscript): LedgerResult {
  const ledger = requireLedger(ledgerInput);
  const sealed = requireSealed(sealedInput);
  if (sealed.companyId !== ledger.companyId || sealed.voiceInterviewId !== ledger.voiceInterviewId) {
    return held(ledger, "cross_tenant");
  }
  // An interview cannot silently switch its application or recruitment on revision.
  if (sealed.roleKey !== ledger.roleKey ||
      sealed.recruitmentId !== ledger.recruitmentId ||
      sealed.applicationId !== ledger.applicationId ||
      sealed.planVersionId !== ledger.planVersionId ||
      sealed.planRevision !== ledger.planRevision ||
      sealed.attemptId !== ledger.attemptId ||
      sealed.providerCallId !== ledger.providerCallId ||
      !samePlanRoster(sealed.planCriteria, ledger.planCriteria)) return held(ledger, "conflict");
  if (sealed.transcriptRevision < ledger.transcriptRevision) return held(ledger, "out_of_order");
  if (sealed.transcriptRevision === ledger.transcriptRevision) {
    const same = sealed.transcriptSha256 === ledger.transcriptSha256 &&
      sealed.sourceFingerprint === ledger.sourceFingerprint &&
      sealed.sourceId === ledger.sourceId &&
      sealed.planRevision === ledger.planRevision &&
      sealed.planVersionId === ledger.planVersionId;
    return held(ledger, same ? "duplicate" : "conflict");
  }
  if (sealed.transcriptRevision !== ledger.transcriptRevision + 1) return held(ledger, "out_of_order");
  return held(freezeLedger({
    ...ledger,
    sourceId: sealed.sourceId,
    planVersionId: sealed.planVersionId,
    planRevision: sealed.planRevision,
    transcriptRevision: sealed.transcriptRevision,
    transcriptSha256: sealed.transcriptSha256,
    sourceFingerprint: sealed.sourceFingerprint,
    pointerVersion: ledger.pointerVersion + 1,
    currentAnalysisId: null,
  }), "applied");
}

export function commitAssessment(ledgerInput: EvidenceLedger, draftInput: AssessmentDraft): LedgerResult {
  const ledger = requireLedger(ledgerInput);
  const draft = requireDraft(draftInput);
  if (draft.companyId !== ledger.companyId || draft.voiceInterviewId !== ledger.voiceInterviewId) {
    return held(ledger, "cross_tenant");
  }
  if (draft.roleKey !== ledger.roleKey) return held(ledger, "conflict");
  if (draft.transcriptSha256 !== ledger.transcriptSha256 || draft.sourceFingerprint !== ledger.sourceFingerprint) {
    return held(ledger, "stale_source");
  }
  if (draft.transcriptRevision !== ledger.transcriptRevision || draft.planRevision !== ledger.planRevision ||
    draft.sourceId !== ledger.sourceId || draft.planVersionId !== ledger.planVersionId) {
    return held(ledger, "revision_mismatch");
  }
  const bound = ownBinding(ledger.idempotency, draft.idempotencyKey);
  if (bound && bound !== draft.fingerprint) return held(ledger, "idempotency_conflict");
  const prior = ledger.analyses.find(item => item.fingerprint === draft.fingerprint);
  if (bound === draft.fingerprint) return held(ledger, "duplicate", prior?.analysisId ?? null);
  if (prior) {
    return held(freezeLedger({
      ...ledger,
      idempotency: { ...ledger.idempotency, [draft.idempotencyKey]: draft.fingerprint },
    }), "duplicate", prior.analysisId);
  }
  const version = ledger.analyses.reduce((max, item) => Math.max(max, item.analysisVersion), 0) + 1;
  const analysisId = `va-${draft.fingerprint}`;
  const stored: StoredAnalysis = {
    analysisId,
    analysisVersion: version,
    idempotencyKey: draft.idempotencyKey,
    fingerprint: draft.fingerprint,
    transcriptSha256: draft.transcriptSha256,
    sourceFingerprint: draft.sourceFingerprint,
    transcriptRevision: draft.transcriptRevision,
    planRevision: draft.planRevision,
    criteria: draft.criteria,
    reviewVersion: 0,
    review: null,
    superseded: false,
  };
  return held(freezeLedger({
    ...ledger,
    lineageVersion: ledger.lineageVersion + 1,
    analyses: [...ledger.analyses, stored],
    idempotency: { ...ledger.idempotency, [draft.idempotencyKey]: draft.fingerprint },
  }), "applied", analysisId);
}

function requireInstant(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) reject("invalid_transcript");
  if (new Date(value).toISOString() !== value) reject("invalid_transcript");
  return value;
}
function effectiveCriteria(analysis: StoredAnalysis): CriterionResult[] {
  const overrides = new Map((analysis.review?.overrides ?? []).map(item => [item.criterionId, item]));
  return analysis.criteria.map(item => overrides.get(item.criterionId) ?? item);
}
function readOverrides(sealed: SealedTranscript, analysis: StoredAnalysis, value: unknown, validity: AssessmentValidity): CriterionResult[] {
  const max = analysis.criteria.length;
  if (!denseArray(value, 0, max)) reject("invalid_transcript");
  if (validity === "approved_with_changes" && value.length < 1) reject("insufficient_evidence");
  if (validity !== "approved_with_changes" && value.length !== 0) reject("invalid_transcript");
  const used = new Set<string>();
  return value.map(item => {
    if (!plainObject(item) || typeof item.criterionId !== "string") reject("invalid_transcript");
    if (used.has(item.criterionId)) reject("conflict");
    used.add(item.criterionId);
    const criterion = analysis.criteria.find(row => row.criterionId === item.criterionId);
    if (!criterion) reject("revision_mismatch");
    const next = validateRating(sealed, {
      criterionId: criterion.criterionId,
      kind: criterion.kind,
      rubricVersion: criterion.rubricVersion,
    }, item);
    const sameEvidence = next.evidence.length === criterion.evidence.length &&
      next.evidence.every((span, index) => span.segmentId === criterion.evidence[index]?.segmentId &&
        span.quote === criterion.evidence[index]?.quote &&
        span.startUtf16 === criterion.evidence[index]?.startUtf16 &&
        span.endUtf16 === criterion.evidence[index]?.endUtf16);
    if (next.rating === criterion.rating && next.rationale === criterion.rationale && sameEvidence) {
      reject("invalid_transcript");
    }
    return next;
  });
}

export function commitReview(
  ledgerInput: EvidenceLedger,
  sealedInput: SealedTranscript,
  reviewInput: unknown,
): LedgerResult {
  const ledger = requireLedger(ledgerInput);
  const sealed = requireSealed(sealedInput);
  let cloned: unknown;
  try {
    cloned = structuredClone(reviewInput);
  } catch {
    reject("invalid_transcript");
  }
  walkKeys(cloned);
  if (!exactKeys(cloned, reviewerOverrideFields)) reject("invalid_transcript");
  if (cloned.schemaVersion !== 1) reject("invalid_transcript");
  if (sealed.companyId !== ledger.companyId || sealed.voiceInterviewId !== ledger.voiceInterviewId) {
    return held(ledger, "cross_tenant");
  }
  if (sealed.roleKey !== ledger.roleKey) return held(ledger, "conflict");
  if (sealed.transcriptSha256 !== ledger.transcriptSha256 || sealed.sourceFingerprint !== ledger.sourceFingerprint) {
    return held(ledger, "stale_source");
  }
  const idempotencyKey = requireIdentity(cloned.idempotencyKey, "opaque");
  const reviewerId = requireIdentity(cloned.reviewerId, "uuid");
  const reviewedAt = requireInstant(cloned.reviewedAt);
  const rationale = safeText(cloned.rationale, 10, 500);
  if (typeof cloned.analysisId !== "string" || cloned.analysisId.length < 8) reject("invalid_transcript");
  if (typeof cloned.assessmentValidity !== "string" ||
    !assessmentValidityScale.includes(cloned.assessmentValidity as AssessmentValidity)) {
    reject("invalid_transcript");
  }
  const validity = cloned.assessmentValidity as AssessmentValidity;
  if (typeof cloned.expectedAnalysisVersion !== "number" || !Number.isSafeInteger(cloned.expectedAnalysisVersion)) {
    reject("invalid_transcript");
  }
  if (typeof cloned.expectedReviewVersion !== "number" || !Number.isSafeInteger(cloned.expectedReviewVersion)) {
    reject("invalid_transcript");
  }
  if (typeof cloned.expectedPointerVersion !== "number" || !Number.isSafeInteger(cloned.expectedPointerVersion) ||
    cloned.expectedPointerVersion < 0) {
    reject("invalid_transcript");
  }
  if (typeof cloned.expectedLineageVersion !== "number" || !Number.isSafeInteger(cloned.expectedLineageVersion) ||
    cloned.expectedLineageVersion < 0) {
    reject("invalid_transcript");
  }
  const expectedCurrentAnalysisId: string | null = cloned.expectedCurrentAnalysisId === null
    ? null
    : typeof cloned.expectedCurrentAnalysisId === "string"
      ? cloned.expectedCurrentAnalysisId
      : reject("invalid_transcript");
  if (typeof cloned.expectedTranscriptSha256 !== "string" || typeof cloned.expectedSourceFingerprint !== "string") {
    reject("invalid_transcript");
  }
  const analysis = ledger.analyses.find(item => item.analysisId === cloned.analysisId);
  if (!analysis) return held(ledger, "conflict");
  const overrides = readOverrides(sealed, analysis, cloned.overrides, validity);
  const fingerprint = sha256Utf8(canonicalize({
    analysis_id: cloned.analysisId,
    assessment_validity: validity,
    expected_analysis_version: cloned.expectedAnalysisVersion,
    expected_current_analysis_id: expectedCurrentAnalysisId,
    expected_lineage_version: cloned.expectedLineageVersion,
    expected_pointer_version: cloned.expectedPointerVersion,
    expected_review_version: cloned.expectedReviewVersion,
    expected_source_fingerprint: cloned.expectedSourceFingerprint,
    expected_transcript_sha256: cloned.expectedTranscriptSha256,
    idempotency_key: idempotencyKey,
    overrides: overrides.map(item => ({
      criterion_id: item.criterionId,
      evidence: item.evidence.map(span => ({
        end_utf16: span.endUtf16,
        quote: span.quote,
        segment_id: span.segmentId,
        start_utf16: span.startUtf16,
      })),
      rating: item.rating,
      rationale: item.rationale,
    })),
    rationale,
    reviewed_at: reviewedAt,
    reviewer_id: reviewerId,
    schema_version: 1,
  }));
  const seen = ownBinding(ledger.reviewIdempotency, idempotencyKey);
  if (seen && seen !== fingerprint) return held(ledger, "idempotency_conflict");
  if (seen === fingerprint) return held(ledger, "duplicate", analysis.analysisId);
  if (cloned.expectedTranscriptSha256 !== sealed.transcriptSha256 ||
    cloned.expectedSourceFingerprint !== sealed.sourceFingerprint ||
    analysis.transcriptSha256 !== ledger.transcriptSha256 ||
    analysis.sourceFingerprint !== ledger.sourceFingerprint ||
    sealed.transcriptSha256 !== ledger.transcriptSha256 ||
    sealed.sourceFingerprint !== ledger.sourceFingerprint) {
    return held(ledger, "stale_source");
  }
  if (cloned.expectedAnalysisVersion !== analysis.analysisVersion ||
    cloned.expectedReviewVersion !== analysis.reviewVersion ||
    cloned.expectedPointerVersion !== ledger.pointerVersion ||
    cloned.expectedLineageVersion !== ledger.lineageVersion ||
    expectedCurrentAnalysisId !== ledger.currentAnalysisId ||
    analysis.review) {
    return held(ledger, "conflict");
  }
  const approving = validity === "approved" || validity === "approved_with_changes";
  const current = ledger.currentAnalysisId
    ? ledger.analyses.find(item => item.analysisId === ledger.currentAnalysisId) ?? null
    : null;
  // A newer committed analysis must be reviewed instead of promoting an older one,
  // including when there is not yet any approved/current pointer.
  if (approving && (ledger.analyses.some(item => item.analysisVersion > analysis.analysisVersion &&
      item.review?.assessmentValidity !== "rejected_result") ||
      (current !== null && analysis.analysisVersion <= current.analysisVersion))) {
    return held(ledger, "conflict");
  }
  const review: StoredReview = {
    assessmentValidity: validity,
    reviewerId,
    reviewedAt,
    rationale,
    overrides,
    fingerprint,
  };
  let analyses = ledger.analyses.map(item => item.analysisId === analysis.analysisId
    ? { ...item, reviewVersion: 1, review }
    : item);
  let pointerVersion = ledger.pointerVersion;
  let currentAnalysisId = ledger.currentAnalysisId;
  if (approving) {
    if (current) {
      analyses = analyses.map(item => item.analysisId === current.analysisId ? { ...item, superseded: true } : item);
    }
    pointerVersion += 1;
    currentAnalysisId = analysis.analysisId;
  }
  return held(freezeLedger({
    ...ledger,
    analyses,
    lineageVersion: ledger.lineageVersion + 1,
    pointerVersion,
    currentAnalysisId,
    reviewIdempotency: { ...ledger.reviewIdempotency, [idempotencyKey]: fingerprint },
  }), "applied", analysis.analysisId);
}

export function readEffectiveResult(ledgerInput: EvidenceLedger): EffectiveResult {
  const ledger = requireLedger(ledgerInput);
  const empty = {
    productionEvidence: false as const,
    authenticated: false as const,
    hireDecision: null,
    pointerVersion: ledger.pointerVersion,
    evidenceTrust: null,
    analysisId: null,
    analysisVersion: null,
    criteria: null,
  };
  if (!ledger.currentAnalysisId) {
    return Object.freeze({ ...empty, state: "none" as const, reason: null });
  }
  const current = ledger.analyses.find(item => item.analysisId === ledger.currentAnalysisId);
  if (!current || current.superseded ||
    current.transcriptSha256 !== ledger.transcriptSha256 ||
    current.sourceFingerprint !== ledger.sourceFingerprint) {
    return Object.freeze({ ...empty, state: "stale" as const, reason: null });
  }
  const validity = current.review?.assessmentValidity;
  if (!current.review || (validity !== "approved" && validity !== "approved_with_changes")) {
    return Object.freeze({
      ...empty,
      state: "withheld" as const,
      reason: validity ?? "unreviewed",
    });
  }
  return Object.freeze({
    state: "current" as const,
    reason: validity,
    productionEvidence: false as const,
    authenticated: false as const,
    hireDecision: null,
    evidenceTrust: "synthetic_fixture" as const,
    analysisId: current.analysisId,
    analysisVersion: current.analysisVersion,
    pointerVersion: ledger.pointerVersion,
    criteria: Object.freeze(effectiveCriteria(current).map(freezeCriterion)),
  });
}
