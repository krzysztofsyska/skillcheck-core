/**
 * SC-012-B B2: pure permission/availability projection for the recruiter panel.
 * Backend must derive role, review and source freshness; this is UI-only gating.
 * No UI predicate authorizes writes in the DB.
 */
export type VoicePlanPanelStatus = "generated" | "reviewed" | "released" | "stale";
export type VoicePlanPanelState = Readonly<{
  status: VoicePlanPanelStatus;
  sourceCurrent: boolean;
  backendReady: boolean;
  role: "owner" | "recruiter" | "viewer";
  reviewIsApproved: boolean;
}>;
export type VoicePlanPanelPermissions = Readonly<{
  reviewEnabled: boolean;
  releaseEnabled: boolean;
  warning: string | null;
}>;

export function getVoicePlanPanelPermissions(
  value: VoicePlanPanelState,
): VoicePlanPanelPermissions {
  if (value.role === "viewer") return {
    reviewEnabled:false, releaseEnabled:false, warning:"Dostęp tylko do odczytu.",
  };
  if (!value.sourceCurrent || value.status === "stale") return {
    reviewEnabled:false, releaseEnabled:false,
    warning:"Źródła analizy zmieniły się. Wygeneruj nowy scenariusz.",
  };
  if (!value.backendReady) return {
    reviewEnabled:false, releaseEnabled:false,
    warning:"Zapis i zatwierdzanie wymagają uruchomienia zweryfikowanego backendu SC-012-B.",
  };
  if (value.status === "reviewed" && !value.reviewIsApproved) return {
    reviewEnabled:false, releaseEnabled:false,
    warning:"Rekruter zgłosił wymagane poprawki. Przygotuj nową wersję scenariusza.",
  };
  return {
    reviewEnabled: value.status==="generated",
    releaseEnabled: value.status==="reviewed" && value.reviewIsApproved,
    warning:null,
  };
}
