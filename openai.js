'use strict';

/**
 * OpenAI-compatible gateway for GPT-AI.
 *
 * Exposes:
 *   GET  /v1/models              -> list the available providers
 *   GET  /v1/models/:id          -> single provider
 *   POST /v1/chat/completions    -> OpenAI Chat Completions (streaming + non-streaming)
 *
 * Requests are translated into the project's own `/chat/vN` scraper routes
 * (called over localhost) and the `{ reply }` response is wrapped back into an
 * OpenAI-style payload, so any OpenAI SDK / client works out of the box.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { invoke } = require('./invoke');
const { PROVIDERS, normalizeModel, DEFAULT_PROVIDER } = require('./providers');

const router = express.Router();

const UPSTREAM_TIMEOUT = toInt(process.env.UPSTREAM_TIMEOUT_MS, 120000);
const STREAM_DELAY_MS = toInt(process.env.STREAM_DELAY_MS, 0);
const REQUIRED_KEY = (process.env.OPENAI_COMPAT_KEY || '').trim();

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Statically reference every scraper router so the serverless bundler
// (@vercel/nft) always includes them — a dynamic require(`./scrapers/${id}`)
// would not be traced and would fail at runtime on Vercel.
const SCRAPER_ROUTERS = {
  v1: require('./scrapers/v1'),
  v2: require('./scrapers/v2'),
  v3: require('./scrapers/v3'),
  v4: require('./scrapers/v4'),
  v5: require('./scrapers/v5'),
  v6: require('./scrapers/v6'),
  v7: require('./scrapers/v7'),
  v8: require('./scrapers/v8'),
  v9: require('./scrapers/v9'),
  v10: require('./scrapers/v10'),
  v11: require('./scrapers/v11'),
  v12: require('./scrapers/v12'),
  v13: require('./scrapers/v13'),
  v14: require('./scrapers/v14'),
  v15: require('./scrapers/v15'),
};

function scraperFor(providerId) {
  return SCRAPER_ROUTERS[providerId];
}

function withTimeout(promise, ms, message) {
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function contentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    }).join('');
  }
  if (typeof content === 'object') return content.text || JSON.stringify(content);
  return String(content);
}

function normalizeMessage(m) {
  const role = ['system', 'user', 'assistant', 'developer', 'tool'].includes(m && m.role) ? m.role : 'user';
  return { role, content: contentToText(m && m.content) };
}

/** Collapse an OpenAI message array into a single prompt string. */
function flattenMessages(messages) {
  const list = (messages || [])
    .map(m => ({ role: m && m.role, text: contentToText(m && m.content) }))
    .filter(m => m.text.trim() !== '');
  if (list.length === 0) return '';
  if (list.length === 1 && list[0].role !== 'system') return list[0].text.trim();

  const systems = list.filter(m => m.role === 'system').map(m => m.text.trim());
  const turns = list
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.text.trim()}`);

  let out = '';
  if (systems.length) out += systems.join('\n') + '\n\n';
  out += turns.join('\n');
  return out.trim();
}

const PASSTHROUGH = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
  'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'reasoning_effort',
];

/** Build the payload forwarded to the `/chat/vN` scraper. */
function buildPayload(provider, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload = {};

  if (provider.mode === 'messages') {
    payload.messages = messages.map(normalizeMessage);
  } else {
    payload.userMessage = flattenMessages(messages);
  }
  if (provider.sendModel && provider.model) payload.model = provider.model;

  for (const key of PASSTHROUGH) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

function estimateUsage(messages, reply) {
  const promptText = (messages || []).map(m => contentToText(m && m.content)).join(' ');
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(1, Math.ceil(String(reply || '').length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function sendError(res, status, message, code) {
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      message,
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      param: null,
      code: code || null,
    },
  });
}

function splitIntoChunks(text, min = 2, max = 6) {
  const out = [];
  let i = 0;
  const src = String(text || '');
  while (i < src.length) {
    const size = min + Math.floor(Math.random() * (max - min + 1));
    out.push(src.slice(i, i + size));
    i += size;
  }
  if (out.length === 0) out.push('');
  return out;
}

function modelListEntry(id, provider) {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: provider.name,
    // Non-standard extras: handy for discovery, ignored by OpenAI clients.
    metadata: {
      label: provider.label,
      upstream_model: provider.model || null,
      mode: provider.mode,
      requires_key: Boolean(provider.envKey),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

router.get('/models', (req, res) => {
  const data = Object.entries(PROVIDERS).map(([id, p]) => modelListEntry(id, p));
  res.json({ object: 'list', data });
});

router.get('/models/:id', (req, res) => {
  const id = normalizeModel(req.params.id);
  if (!id) return sendError(res, 404, `The model \`${req.params.id}\` does not exist.`, 'model_not_found');
  res.json(modelListEntry(id, PROVIDERS[id]));
});

router.post('/chat/completions', async (req, res) => {
  const body = req.body || {};

  if (REQUIRED_KEY) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (token !== REQUIRED_KEY) {
      return sendError(res, 401, 'Incorrect API key provided.', 'invalid_api_key');
    }
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, "'messages' is a required property and must be a non-empty array.");
  }

  const requested = body.model;
  const providerId = normalizeModel(requested) || normalizeModel(req.query.provider) || DEFAULT_PROVIDER;
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return sendError(res, 404, `The model \`${requested}\` does not exist.`, 'model_not_found');
  }

  const payload = buildPayload(provider, body);
  const headers = {};
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  let reply;
  try {
    // Invoke the scraper router in-process — no HTTP hop, no bound port. This
    // is what makes the gateway work on serverless platforms (e.g. Vercel),
    // where nothing is ever listening on 127.0.0.1.
    const result = await withTimeout(
      invoke(scraperFor(providerId), { method: 'POST', url: '/', headers, body: payload }),
      UPSTREAM_TIMEOUT,
      `provider '${providerId}' timed out after ${UPSTREAM_TIMEOUT}ms`
    );
    const data = result.body;
    if (result.statusCode >= 400 || !data || data.reply === undefined || data.reply === null) {
      const raw = data && (data.details || data.error);
      const msg = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : `upstream status ${result.statusCode}`;
      throw new Error(msg);
    }
    reply = typeof data.reply === 'string' ? data.reply : String(data.reply);
  } catch (err) {
    return sendError(
      res,
      502,
      `Provider '${providerId}' failed to return a completion: ${err.message}`,
      'upstream_error'
    );
  }

  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '');
  const created = Math.floor(Date.now() / 1000);

  if (body.stream === true || body.stream === 'true') {
    return sendStream(req, res, {
      id,
      created,
      model: providerId,
      reply,
      includeUsage: Boolean(body.stream_options && body.stream_options.include_usage),
    });
  }

  res.json({
    id,
    object: 'chat.completion',
    created,
    model: providerId,
    choices: [
      { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
    ],
    usage: estimateUsage(body.messages, reply),
  });
});

/** Stream `reply` back to the client as OpenAI chat.completion.chunk events. */
function sendStream(req, res, { id, created, model, reply, includeUsage }) {
  let closed = false;
  req.on('close', () => { closed = true; });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const base = { id, object: 'chat.completion.chunk', created, model };
  const write = (choices) => res.write(`data: ${JSON.stringify({ ...base, choices })}\n\n`);

  write([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);

  const chunks = splitIntoChunks(reply);
  let i = 0;

  const tick = () => {
    if (closed) return;
    if (i >= chunks.length) {
      write([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      if (includeUsage) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: estimateUsage([], reply) })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    write([{ index: 0, delta: { content: chunks[i++] }, finish_reason: null }]);
    if (STREAM_DELAY_MS > 0) setTimeout(tick, STREAM_DELAY_MS);
    else setImmediate(tick);
  };

  tick();
}

module.exports = router;
