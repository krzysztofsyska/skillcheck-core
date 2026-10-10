"use client";

import { useState } from "react";
import {
  getVoicePlanPanelPermissions,
  type VoicePlanPanelStatus,
} from "../../lib/voice/plan-panel-state";

export type PlanQuestionView = Readonly<{
  id: string;
  kind: "common" | "clarification";
  criterionId: string;
  criterionKind: "behavior" | "task" | "kpi" | "competency";
  text: string;
  followUps: readonly string[];
}>;
export type VoicePlanApprovalView = Readonly<{
  id: string;
  status: VoicePlanPanelStatus;
  planVersion: number;
  sourceHash: string;
  sourceCurrent: boolean;
  reviewIsApproved: boolean;
  questions: readonly PlanQuestionView[];
  reviewerLabel: string | null;
  reviewedAt: string | null;
}>;
type ReviewDecision = "approved" | "requires_changes";
export type VoicePlanApprovalPanelProps = {
  plan: VoicePlanApprovalView;
  role: "owner" | "recruiter" | "viewer";
  /** Remains false until SC-012-B DB migrations / RPC and E2E are approved. */
  backendReady?: boolean;
  onReview?: (args: Readonly<{
    planId: string; expectedVersion: number; expectedSourceHash: string;
    decision: ReviewDecision;
  }>) => Promise<void>;
  onRelease?: (args: Readonly<{
    planId: string; expectedVersion: number; expectedSourceHash: string;
  }>) => Promise<void>;
};

const label: Record<VoicePlanPanelStatus, string> = {
  generated:"Wygenerowany — oczekuje na weryfikację",
  reviewed:"Zweryfikowany przez rekrutera",
  released:"Wydany scenariusz (bez prawa uruchomienia połączenia)",
  stale:"Nieaktualny — wymagana nowa wersja",
};
const questionKind = {
  common:"Pytanie wspólne",
  clarification:"Dopytanie do kryterium",
};

export function VoicePlanApprovalPanel({
  plan, role, backendReady=false, onReview, onRelease,
}: VoicePlanApprovalPanelProps) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string | null>(null);
  const [comment,setComment]=useState("");
  const permissions=getVoicePlanPanelPermissions({
    status:plan.status,sourceCurrent:plan.sourceCurrent,backendReady,
    role,reviewIsApproved:plan.reviewIsApproved,
  });
  const canReview=permissions.reviewEnabled && !!onReview && !busy;
  const canRelease=permissions.releaseEnabled && !!onRelease && !busy;
  async function review(decision: ReviewDecision) {
    if (!canReview || !onReview) return;
    setBusy(true); setError(null);
    try {
      // No actor/tenant IDs are supplied by the browser. Verified RPC derives them.
      await onReview({planId:plan.id,expectedVersion:plan.planVersion,
        expectedSourceHash:plan.sourceHash,decision});
      setComment("");
    } catch { setError("Nie udało się zapisać oceny. Odśwież źródła i spróbuj ponownie."); }
    finally { setBusy(false); }
  }
  async function release() {
    if (!canRelease || !onRelease) return;
    setBusy(true); setError(null);
    try {
      await onRelease({planId:plan.id,expectedVersion:plan.planVersion,
        expectedSourceHash:plan.sourceHash});
    } catch { setError("Nie udało się wydać scenariusza. Sprawdź jego aktualność."); }
    finally { setBusy(false); }
  }
  return (
    <section aria-label="Przegląd scenariusza rozmowy" style={{maxWidth:900,margin:"0 auto",padding:24}}>
      <header>
        <h2>Scenariusz rozmowy kwalifikacyjnej</h2>
        <p><strong>Wersja:</strong> {plan.planVersion} · <strong>Status:</strong> {label[plan.status]}</p>
        <p>Planowana rozmowa: 5–7 minut. Limit: 10 minut. Nagrywanie domyślnie wyłączone.</p>
        {!plan.sourceCurrent && <p role="alert">Kryteria lub dane rekrutacji uległy zmianie. Nie można zatwierdzić tego scenariusza.</p>}
        {permissions.warning && <p role="status">{permissions.warning}</p>}
      </header>
      <ol style={{paddingLeft:25}}>
        {plan.questions.map((q,index)=>(
          <li key={q.id} style={{marginBottom:16,padding:12,border:"1px solid #ddd",borderRadius:8}}>
            <p style={{margin:0,fontSize:13}}>{questionKind[q.kind]} {index+1} · Kryterium: {q.criterionKind}/{q.criterionId}</p>
            <p><strong>{q.text}</strong></p>
            {q.followUps.length>0 && <div><p>Dopytania pomocnicze:</p><ul>{q.followUps.map((s,i)=><li key={i}>{s}</li>)}</ul></div>}
          </li>
        ))}
      </ol>
      <p>Decyzje dotyczą oceny scenariusza, nie zatrudnienia kandydata ani uruchomienia telefonu.</p>
      {plan.reviewerLabel && <p>Ostatni przegląd: {plan.reviewerLabel}{plan.reviewedAt ? " · "+plan.reviewedAt : ""}</p>}
      <fieldset disabled={!canReview}>
        <legend>Decyzja rekrutera</legend>
        <label htmlFor="voice-plan-comment">Notatka robocza (nie jest wysyłana)</label>
        <textarea id="voice-plan-comment" value={comment} onChange={e=>setComment(e.target.value.slice(0,1000))}
          rows={3} maxLength={1000} style={{display:"block",width:"100%",marginBottom:12}} />
        <button type="button" onClick={()=>review("approved")}>Zatwierdź scenariusz</button>
        {" "}
        <button type="button" onClick={()=>review("requires_changes")}>Wymaga poprawy</button>
      </fieldset>
      <div style={{marginTop:16}}>
        <button type="button" onClick={release} disabled={!canRelease}>Wydaj zatwierdzony scenariusz</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!backendReady && <p>Tryb podglądu: żadne zatwierdzenie nie jest zapisywane i żaden kandydat nie otrzymuje połączenia.</p>}
    </section>
  );
}
