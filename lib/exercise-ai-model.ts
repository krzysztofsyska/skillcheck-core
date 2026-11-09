// SC-021-A2: the model contract of exercise generation, kept free of imports so that the AI gateway
// policy can name it without pulling exercise-ai.ts (Node crypto, database types) into the
// screening worker's Supabase Edge bundle.
export const EXERCISE_AI_PROVIDER = 'openai';
export const EXERCISE_AI_MODEL = 'gpt-5.4-mini-2026-03-17';
export const EXERCISE_AI_MODEL_REVISION = null;
export const EXERCISE_AI_REQUEST_TIMEOUT_MS = 60000;
