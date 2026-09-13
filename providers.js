'use strict';

/**
 * Provider registry for the OpenAI-compatible gateway (see openai.js).
 *
 * Every provider maps one-to-one to a `/chat/vN` scraper route mounted in
 * index.js. The fields describe how a normalised OpenAI request must be
 * forwarded to that route:
 *
 *   mode       'messages' -> the scraper accepts a full OpenAI-style `messages`
 *                            array. We forward the messages untouched.
 *              'prompt'   -> the scraper only accepts a single `userMessage`
 *                            string. The conversation is flattened into one prompt.
 *   envKey     the env var the scraper reads when the client did not supply an
 *              `Authorization` header. `undefined` means the provider needs no key.
 *   sendModel  whether it is safe to forward a `model` field to the scraper
 *              (only the OpenAI-compatible upstreams understand it; the others
 *              pick a fixed model internally).
 *   model      the upstream model id used when `sendModel` is true.
 */

const PROVIDERS = {
  v1:  { name: 'pollinations',  label: 'Pollinations Gen AI',      mode: 'messages', envKey: 'POLLINATIONS_API_KEY', sendModel: true,  model: 'openai' },
  v2:  { name: 'openrouter',    label: 'OpenRouter',               mode: 'messages', envKey: 'OPENROUTER_API_KEY',  sendModel: true,  model: 'openrouter/free' },
  v3:  { name: 'riple',         label: 'Riple AI (SAANVI)',        mode: 'messages' },
  v4:  { name: 'unlimitedai',   label: 'unlimitedai.chat',         mode: 'prompt' },
  v5:  { name: 'goody2',        label: 'Goody2 AI',                mode: 'prompt' },
  v6:  { name: 'chat-smith',    label: 'Chat Smith (gpt-4o-mini)', mode: 'messages' },
  v7:  { name: 'freedomgpt',    label: 'FreedomGPT (weaver)',      mode: 'messages', envKey: 'FREEDOMGPT_API_KEY', sendModel: true,  model: 'weaver' },
  v8:  { name: 'chat-fiction',  label: 'Chat with Fiction',        mode: 'prompt' },
  v9:  { name: 'bookai',        label: 'bookai.chat (gpt-3.5)',    mode: 'prompt' },
  v10: { name: 'publicai',      label: 'PublicAI',                 mode: 'messages' },
  v11: { name: 'supabase-nano', label: 'Supabase (gpt-5-nano)',    mode: 'prompt' },
  v12: { name: 'airforce',      label: 'api.airforce (llama)',     mode: 'messages', envKey: 'AIRFORCE_API_KEY',   sendModel: true,  model: 'llama-instant' },
  v13: { name: 'supabase-mini', label: 'Supabase (gpt-5-mini)',    mode: 'prompt' },
  v14: { name: 'chataibot',     label: 'Chataibot',                mode: 'prompt' },
  v15: { name: 'dopple',       label: 'Dopple AI',                 mode: 'prompt' },
};

/**
 * Resolve a user supplied model id to a provider key (v1..v15).
 *
 * Accepted forms (case-insensitive):
 *   - "v5", "V5"
 *   - "gpt-ai-v5", "gptai/v5", "gpt-ai/v5"
 *   - "chat/v5"
 *   - the provider name, e.g. "goody2"
 *
 * Returns the provider key, or null when nothing matches.
 */
function normalizeModel(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.trim().toLowerCase();
  if (!m) return null;

  const direct = m.match(/^(?:gpt-?ai[-/])?(?:chat\/)?v(\d+)$/);
  if (direct) {
    const id = `v${direct[1]}`;
    return PROVIDERS[id] ? id : null;
  }

  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (id === m || p.name === m) return id;
  }
  return null;
}

const DEFAULT_PROVIDER = normalizeModel(process.env.DEFAULT_PROVIDER) || 'v1';

module.exports = { PROVIDERS, normalizeModel, DEFAULT_PROVIDER };
