import { browserResponseFormat, browserSchemaInstruction } from '../config/browserSchemas.js';
import { ApiError } from '../utils/ApiError.js';

/** One logical model turn, with at most one recovery from Groq JSON validation
 * failure. Keys and rejected generations never reach browser responses/logs.
 * Schema, pin and physical design checks still run in the browser worker. */
export const requestBrowserCompletion = async ({ key, model, messages, purpose, byok }) => {
  const body = {
    model,
    messages: [{ role: 'system', content: browserSchemaInstruction(purpose) }, ...messages],
    temperature: 0.2,
    max_completion_tokens: 4096,
    response_format: browserResponseFormat(model, purpose),
    ...(model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low', include_reasoning: false } : {}),
  };
  // Both attempts share the original timeout; recovery cannot double latency.
  const signal = AbortSignal.timeout(60_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal,
      });
    } catch {
      throw new ApiError(503, signal.aborted
        ? 'Groq took too long to respond. Try again shortly.'
        : 'Groq could not be reached. Try again shortly.');
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        // HTTP success may already have incurred provider usage.
        const error = ApiError.badGateway('Groq returned malformed JSON');
        error.providerSucceeded = true;
        throw error;
      }
    }

    // Do not forward the raw error: failed_generation can contain private
    // project context. Only this explicit provider code permits a retry.
    const rejected = await response.json().catch(() => null);
    if (response.status === 400 && rejected?.error?.code === 'json_validate_failed') {
      if (attempt === 0) {
        body.response_format = { type: 'json_object' };
        body.messages[0].content += '\nA previous attempt failed JSON validation. Follow all required fields, nullable values and enums exactly. Produce JSON only.';
        continue;
      }
      throw ApiError.unprocessable('Groq could not produce valid design or code JSON. Try a smaller or more focused request.');
    }
    if (response.status === 429) throw ApiError.tooMany('Groq is rate limited. Try again shortly.');
    if (response.status === 401 || response.status === 403) {
      throw ApiError.badGateway(byok ? 'Your Groq key was rejected. Update it in Settings.' : 'Groq authentication or model access failed. Check the backend Groq configuration.');
    }
    if (response.status === 400 || response.status === 404) {
      throw ApiError.badGateway('Groq rejected the model configuration. Check GROQ_BROWSER_MODEL and model access in the Groq console.');
    }
    throw ApiError.badGateway(`Groq is temporarily unavailable (HTTP ${response.status}). Try again shortly.`);
  }
};
