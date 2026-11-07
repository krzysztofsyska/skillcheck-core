import {
  buildExerciseDraftRequest, ExerciseAiError, EXERCISE_AI_MAX_RESPONSE_CHARS,
  EXERCISE_AI_REQUEST_TIMEOUT_MS, EXERCISE_AI_MAX_REQUEST_BYTES, mapExerciseAiHttpError,
  parseExerciseDraftResponse, type exerciseDraftPayload, type ExerciseAiResponse,
} from './exercise-ai.ts';

/** Exactly one attempt. A lost response may already be billed; never retry here. */
export async function requestExerciseDraft(payload: ReturnType<typeof exerciseDraftPayload>, apiKey: string,
  fetcher: typeof fetch = fetch) {
  if (!apiKey) throw new ExerciseAiError('exercise_ai_auth_error', 'Missing provider configuration');
  const body = JSON.stringify(buildExerciseDraftRequest(payload));
  if (Buffer.byteLength(body, 'utf8') > EXERCISE_AI_MAX_REQUEST_BYTES)
    throw new ExerciseAiError('exercise_ai_input_too_large', 'Provider request exceeds byte limit.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXERCISE_AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new ExerciseAiError(mapExerciseAiHttpError(response.status), 'Provider failed');
    if (!response.body) throw new ExerciseAiError('exercise_ai_invalid_output', 'Missing response');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let text = ''; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > EXERCISE_AI_MAX_RESPONSE_CHARS * 4) {
          await reader.cancel(); throw new ExerciseAiError('exercise_ai_invalid_output', 'Response too large');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ExerciseAiError('exercise_ai_invalid_output', 'Invalid JSON'); }
    return parseExerciseDraftResponse(parsed as ExerciseAiResponse, payload);
  } catch (error) {
    if (error instanceof ExerciseAiError) throw error;
    throw new ExerciseAiError(controller.signal.aborted ? 'exercise_ai_timeout' : 'exercise_ai_network_error', 'Provider unavailable');
  } finally { clearTimeout(timer); }
}
