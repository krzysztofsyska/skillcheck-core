// SC-021-A: the policy in force. Changing a route is a reviewed change of this file
// (or, later, of the operator-managed policy table in SC-021-C) — business modules do not change.
import { SCREENING_OPENAI_MODEL, SCREENING_OPENAI_MODEL_REVISION, SCREENING_OPENAI_REQUEST_TIMEOUT_MS } from '../screening-ai.ts';
import { EXERCISE_AI_MODEL, EXERCISE_AI_MODEL_REVISION, EXERCISE_AI_REQUEST_TIMEOUT_MS } from '../exercise-ai-model.ts';
import { validatePolicy } from './policy.ts';

export const DEFAULT_AI_POLICY_VERSION = 'sc021-a2-2026-11-09';

const rawDefaultPolicy = {
  version: DEFAULT_AI_POLICY_VERSION,
  models: {
    // The screening and exercise result contracts name this exact model; routes using it are pinned.
    'openai-screening': {
      provider: 'openai', model: SCREENING_OPENAI_MODEL, revision: SCREENING_OPENAI_MODEL_REVISION,
      quality: 'standard', costRank: 10, enabled: true,
    },
    'openai-exercise': {
      provider: 'openai', model: EXERCISE_AI_MODEL, revision: EXERCISE_AI_MODEL_REVISION,
      quality: 'standard', costRank: 10, enabled: true,
    },
    // Adapter exists for portability; the provider is not on ACTIVE_AI_PROVIDERS, so this entry is
    // never routed to, even though it is listed. Kept disabled as well (two independent locks).
    'anthropic-standard': {
      provider: 'anthropic', model: 'claude-sonnet-5-5', revision: null,
      quality: 'standard', costRank: 12, enabled: false,
    },
  },
  routes: {
    cv_screening: {
      strategy: 'pinned', candidates: ['openai-screening'], minQuality: 'standard',
      // One physical attempt per gateway call: the screening worker keeps its own retry loop
      // (SCREENING_OPENAI_MAX_RETRIES, backoff), so retry counts stay what they were before A2.
      timeoutMs: SCREENING_OPENAI_REQUEST_TIMEOUT_MS, maxAttempts: 1, retryMaybeBilled: false,
      // Deliberately off (SC-021-A2, see docs/sc-021-a-ai-gateway.md "Blokada danych kontaktowych"):
      // redacted CVs pass the detector, but recruiter-typed criteria with 9-digit figures
      // ("budżet 500 000 000 zł") read as phone numbers, and screening has no error code for it.
      // CV text is redacted upstream (suggestRedaction + recruiter review; bulk: detector check).
      blockContactData: false,
      // Backstop only: the CV text limit (100 000 characters) is enforced at intake; this must not
      // reject a payload the direct path accepts (multi-byte Polish text, JSON escaping).
      maxInputBytes: 2_000_000,
    },
    exercise_generation: {
      strategy: 'pinned', candidates: ['openai-exercise'], minQuality: 'standard',
      timeoutMs: EXERCISE_AI_REQUEST_TIMEOUT_MS, maxAttempts: 1, retryMaybeBilled: false,
      // Deliberately off: the payload is the company and position profile only (no candidate data),
      // where a company phone or e-mail is legitimate; blocking it would fail drafts that work today.
      // The wire body stays capped at EXERCISE_AI_MAX_REQUEST_BYTES (48 000) before the gateway.
      blockContactData: false, maxInputBytes: 64_000,
    },
  },
} as const;

export const defaultAiPolicy = validatePolicy(JSON.parse(JSON.stringify(rawDefaultPolicy)));
