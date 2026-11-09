// SC-021-A: the policy in force. Changing a route is a reviewed change of this file
// (or, later, of the operator-managed policy table in SC-021-C) — business modules do not change.
import { SCREENING_OPENAI_MODEL, SCREENING_OPENAI_MODEL_REVISION, SCREENING_OPENAI_REQUEST_TIMEOUT_MS } from '../screening-ai.ts';
import { EXERCISE_AI_MODEL, EXERCISE_AI_MODEL_REVISION, EXERCISE_AI_REQUEST_TIMEOUT_MS } from '../exercise-ai.ts';
import { validatePolicy } from './policy.ts';

export const DEFAULT_AI_POLICY_VERSION = 'sc021-a-2026-11-09';

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
      timeoutMs: SCREENING_OPENAI_REQUEST_TIMEOUT_MS, maxAttempts: 1, retryMaybeBilled: false,
      // CV text reaching the gateway is already redacted and checked by the CV pipeline.
      blockContactData: true, maxInputBytes: 200_000,
    },
    exercise_generation: {
      strategy: 'pinned', candidates: ['openai-exercise'], minQuality: 'standard',
      timeoutMs: EXERCISE_AI_REQUEST_TIMEOUT_MS, maxAttempts: 1, retryMaybeBilled: false,
      blockContactData: true, maxInputBytes: 64_000,
    },
  },
} as const;

export const defaultAiPolicy = validatePolicy(JSON.parse(JSON.stringify(rawDefaultPolicy)));
