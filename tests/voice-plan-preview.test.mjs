// ROADMAP R6-1d — podgląd scenariusza rozmowy dla rekrutera za flagą VOICE_PLAN_PREVIEW.
// Dane są fikcyjne; żadnego prawdziwego CV ani nazwiska.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { behaviorAreas } from "../lib/position-fields.ts";
import { getVoicePlanPanelPermissions } from "../lib/voice/plan-panel-state.ts";
import {
  buildVoicePlanPreview, voicePlanPreviewEnabled, voicePlanPreviewStateLabels,
} from "../lib/voice/plan-preview.ts";

const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const FP = "a".repeat(64);
const pageDir = "../app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("flag is off by default and never on in Production", () => {
  assert.equal(voicePlanPreviewEnabled({}), false);
  assert.equal(voicePlanPreviewEnabled({ VERCEL_ENV: "preview" }), false);
  assert.equal(voicePlanPreviewEnabled({ NODE_ENV: "development" }), false);
  for (const value of ["1", "TRUE", "yes", " true", ""]) {
    assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: value, VERCEL_ENV: "preview" }), false, value);
  }
  assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: "true", VERCEL_ENV: "production" }), false);
  assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: "true", VERCEL_ENV: "production", NODE_ENV: "development" }), false);
  // `next start` outside Vercel: NODE_ENV=production and no VERCEL_ENV.
  assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: "true", NODE_ENV: "production" }), false);
  assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: "true", VERCEL_ENV: "development" }), false);
  assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: "true", VERCEL_ENV: "preview" }), true);
  assert.equal(voicePlanPreviewEnabled({ VOICE_PLAN_PREVIEW: "true", NODE_ENV: "development" }), true);
});

test("route answers 404 before any read when the flag is off; link is behind the same flag", () => {
  const page = read(pageDir + "interview-plan/page.tsx");
  const body = page.slice(page.indexOf("export default async function"));
  const firstLine = body.split("\n")[1].trim();
  assert.equal(firstLine, "if (!voicePlanPreviewEnabled()) notFound();");
  assert.ok(body.indexOf("notFound();") < body.indexOf("await "), "flag check precedes every await");
  assert.match(page, /if \(!canEdit\) notFound\(\);/, "owner or recruiter only");
  assert.match(page, /backendReady=\{false\}/, "approval stays disabled");
  assert.doesNotMatch(page, /onReview|onRelease|service_role|createAdminClient|redacted_text/);
  assert.doesNotMatch(page, /voicebot|\bbot\b/i);
  const interview = read(pageDir + "interview/page.tsx");
  assert.match(interview, /\{voicePlanPreviewEnabled\(\) && <li><Link href=\{`\$\{base\}\/applications\/\$\{route\.applicationId\}\/interview-plan`\}>/);
});

const position = () => ({
  title: "Kierownik sprzedaży", tasks: ["Zarządzanie zespołem", "Planowanie"], kpis: ["Przychody regionu"],
  required_competencies: ["Zarządzanie ludźmi"], updated_at: "2026-11-18T10:00:00.000Z",
  required_behaviors: behaviorAreas.map(([, label], n) => label + ": " + (n < 2 ? "Krytyczny" : "Standardowy")),
});
const criteria = [
  { id: "task:1", kind: "task", text: "Zarządzanie zespołem" }, { id: "task:2", kind: "task", text: "Planowanie" },
  { id: "kpi:1", kind: "kpi", text: "Przychody regionu" }, { id: "competency:1", kind: "competency", text: "Zarządzanie ludźmi" },
];
const ratings = { "task:1": "meets", "task:2": "insufficient_data", "kpi:1": "insufficient_data", "competency:1": "above" };
const source = (extra = {}) => ({
  companyId: uuid(1), applicationId: uuid(3), position: position(), fingerprint: FP,
  entry: { application_id: uuid(3), analysis_id: uuid(10), review_id: uuid(20), removed_at: null },
  analysis: { id: uuid(10), application_id: uuid(3), execution_status: "completed", input_fingerprint: FP,
    stale_at: null, latest_review_version: 1, criteria_snapshot: criteria },
  review: { id: uuid(20), analysis_id: uuid(10), review_version: 1, disposition: "approved" },
  results: criteria.map((c, i) => ({ id: uuid(100 + i), analysis_id: uuid(10), criterion_id: c.id, rating: ratings[c.id] })),
  overrides: [],
  ...extra,
});

test("ready: plan from approved screening gaps, minimal data only", () => {
  const preview = buildVoicePlanPreview(source());
  assert.equal(preview.state, "ready");
  const { plan } = preview;
  assert.equal(plan.status, "generated");
  assert.equal(plan.reviewIsApproved, false);
  assert.equal(plan.questions.filter(q => q.kind === "common").length, 4);
  assert.deepEqual(plan.questions.filter(q => q.kind === "clarification").map(q => q.criterionId), ["task:2", "kpi:1"]);
  const json = JSON.stringify(plan);
  for (const forbidden of ["00000000-0000-4000", "Kierownik", "Zarządzanie zespołem", "Przychody", "maxSeconds"]) {
    assert.ok(!json.includes(forbidden), forbidden);
  }
});

test("human override is respected (approved_with_changes)", () => {
  const preview = buildVoicePlanPreview(source({
    review: { id: uuid(20), analysis_id: uuid(10), review_version: 1, disposition: "approved_with_changes" },
    overrides: [{ review_id: uuid(20), criterion_result_id: uuid(101), rating_override: "meets" }],
  }));
  assert.equal(preview.state, "ready");
  assert.deepEqual(preview.plan.questions.filter(q => q.kind === "clarification").map(q => q.criterionId), ["kpi:1"]);
});

test("gate: shortlist, analysis, human approval and freshness are required", () => {
  const s = source();
  const cases = [
    [{ entry: null }, "not_shortlisted"],
    [{ entry: { ...s.entry, removed_at: "2026-11-18T10:00:00Z" } }, "not_shortlisted"],
    [{ entry: { ...s.entry, application_id: uuid(4) } }, "not_shortlisted"],
    [{ analysis: null }, "no_analysis"],
    [{ analysis: { ...s.analysis, execution_status: "processing" } }, "no_analysis"],
    [{ fingerprint: undefined }, "outdated"],
    [{ fingerprint: "b".repeat(64) }, "outdated"],
    [{ analysis: { ...s.analysis, stale_at: "2026-11-18T10:00:00Z" } }, "outdated"],
    [{ review: null }, "awaiting_review"],
    [{ analysis: { ...s.analysis, latest_review_version: 2 } }, "awaiting_review"],
    [{ review: { ...s.review, disposition: "needs_reanalysis" } }, "outdated"],
    [{ entry: { ...s.entry, review_id: uuid(21) } }, "outdated"],
    [{ entry: { ...s.entry, analysis_id: uuid(11) } }, "outdated"],
    [{ review: { ...s.review, analysis_id: uuid(11) } }, "unavailable"],
    [{ results: s.results.slice(1) }, "unavailable"],
    [{ results: s.results.map(r => ({ ...r, analysis_id: uuid(11) })) }, "unavailable"],
    [{ position: { ...s.position, required_behaviors: [] } }, "unavailable"],
    [{ analysis: { ...s.analysis, criteria_snapshot: null } }, "unavailable"],
    [{ review: { ...s.review, disposition: "approved_with_changes" } }, "unavailable"],
  ];
  for (const [extra, expected] of cases) {
    assert.equal(buildVoicePlanPreview(source(extra)).state, expected, JSON.stringify(extra));
  }
  for (const label of Object.values(voicePlanPreviewStateLabels)) assert.doesNotMatch(label, /voice|\bbot\b/i);
});

test("panel renders the preview read-only with every action disabled", () => {
  const compiled = ts.transpileModule(read("../components/voice/VoicePlanApprovalPanel.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, require(name) {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name.endsWith("plan-panel-state")) return { getVoicePlanPanelPermissions };
    throw Error("Unapproved import: " + name);
  } });
  const { plan } = buildVoicePlanPreview(source());
  const html = renderToStaticMarkup(React.createElement(exports.VoicePlanApprovalPanel, { plan, role: "recruiter", backendReady: false }));
  assert.match(html, /Scenariusz rozmowy kwalifikacyjnej/);
  assert.match(html, /Tryb podglądu/);
  assert.match(html, /<fieldset disabled="">/);
  assert.match(html, /<button type="button" disabled="">Wydaj zatwierdzony scenariusz<\/button>/);
  for (const q of plan.questions) assert.ok(html.includes(q.text.replace(/"/g, "&quot;")), q.id);
  assert.doesNotMatch(html, /voicebot|\bbot\b/i);
});
