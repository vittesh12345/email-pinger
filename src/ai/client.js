import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../settings.js';

// Models that support server-side refusal fallback. On a policy decline the API re-runs the
// request on Anthropic's recommended substitute instead of handing back a refusal.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AiError extends Error {
  constructor(message, code = 'ai_error') {
    super(message);
    this.code = code;
  }
}

let createClient = (apiKey) => new Anthropic({ apiKey });

/** Tests swap in a fake client here. */
export function setClientFactory(fn) {
  createClient = fn;
}

export function aiConfig() {
  const settings = getSettings();
  const apiKey = settings.ai.apiKey || process.env.ANTHROPIC_API_KEY || '';
  return { apiKey, model: settings.ai.model, enabled: !!apiKey };
}

export const aiEnabled = () => aiConfig().enabled;

function translate(err) {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new AiError('The AI key was rejected. Check it in Settings.', 'auth');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AiError('This AI key is not allowed to use the selected model.', 'permission');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AiError('The selected AI model is not available for this key.', 'model');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AiError('The AI service is rate-limiting requests. Pinger will try again later.', 'rate_limit');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AiError(`The AI service rejected the request: ${err.message}`, 'bad_request');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiError('Could not reach the AI service. Check your internet connection.', 'network');
  }
  if (err instanceof Anthropic.APIError) {
    return new AiError(`The AI service returned an error (${err.status ?? 'unknown'}).`, 'api');
  }
  return new AiError(err?.message || 'Unknown AI error');
}

/**
 * One request, one answer. Returns text, or the parsed object when `schema` is given.
 *
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.prompt
 * @param {object} [args.schema]   JSON schema; constrains the reply to valid JSON
 * @param {'low'|'medium'|'high'} [args.effort]
 */
export async function complete({ system, prompt, schema, effort = 'low' }) {
  const { apiKey, model, enabled } = aiConfig();
  if (!enabled) throw new AiError('No AI key is configured.', 'not_configured');

  const params = {
    model,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }

  let message;
  try {
    // Streaming keeps long transcripts from tripping HTTP timeouts.
    message = await createClient(apiKey).beta.messages.stream(params).finalMessage();
  } catch (err) {
    throw translate(err);
  }

  if (message.stop_reason === 'refusal') {
    throw new AiError('The AI declined to process this content.', 'refusal');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AiError('The AI ran out of room before finishing. Try a shorter input.', 'max_tokens');
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('The AI returned a reply Pinger could not read.', 'parse');
  }
}
