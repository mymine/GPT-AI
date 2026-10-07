'use strict';

/**
 * OpenAI-compatible gateway for GPT-AI.
 *
 * Exposes:
 *   GET  /v1/models              -> list the available providers
 *   GET  /v1/models/:id          -> single provider
 *   POST /v1/chat/completions    -> OpenAI Chat Completions (streaming + non-streaming + tools)
 *
 * Requests are translated into the project's own `/chat/vN` scraper routes and
 * the `{ reply }` response is wrapped back into an OpenAI-style payload. Tool
 * calling (OpenAI `tools` / `tool_calls`) is supported for **every** provider:
 * since most backends have no native function-calling API, the gateway injects
 * a tools instruction into the prompt and parses the model's JSON reply back
 * into a standard `tool_calls` array. Execution of the tool is done by the
 * client — the gateway only carries the call back and forth.
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { invoke } = require('./invoke');
const { PROVIDERS, normalizeModel, DEFAULT_PROVIDER } = require('./providers');
const {
  contentToText,
  buildToolsInstruction,
  normalizeMessages,
  flattenMessages,
  parseReply,
} = require('./tools');

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

const PASSTHROUGH = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
  'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'reasoning_effort',
];

/**
 * Cap a folded prompt to `max` chars, keeping the tail (most recent turns) and
 * preserving the tools instruction at the front when it fits. Used for backends
 * with an input-length limit (e.g. v14's 2500 chars per message).
 */
function capTail(text, max, toolsInstruction) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!max || s.length <= max) return s;
  const note = '…[truncated]';
  if (toolsInstruction && s.startsWith(toolsInstruction) && toolsInstruction.length + note.length < max) {
    const tailBudget = Math.max(0, max - toolsInstruction.length - note.length - 1);
    return `${toolsInstruction}\n${note}${s.slice(-tailBudget)}`;
  }
  return note + s.slice(-(max - note.length));
}

/** Build the payload forwarded to the `/chat/vN` scraper. */
function buildPayload(provider, body, toolsInstruction) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload = {};

  if (provider.mode === 'messages') {
    payload.messages = normalizeMessages(messages, toolsInstruction);
  } else {
    let text = flattenMessages(messages, toolsInstruction);
    // Backends with a hard input limit: keep the tail so the request still
    // succeeds instead of being rejected for exceeding the limit.
    if (provider.maxInputChars) text = capTail(text, provider.maxInputChars, toolsInstruction);
    payload.userMessage = text;
  }
  if (provider.sendModel && provider.model) payload.model = provider.model;

  for (const key of PASSTHROUGH) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

function estimateUsage(messages, output) {
  const promptText = (messages || [])
    .map(m => contentToText(m && m.content) + (m && m.tool_calls ? JSON.stringify(m.tool_calls) : ''))
    .join(' ');
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(1, Math.ceil(String(output || '').length / 4));
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
      supports_tools: true,
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

  // ---- tool calling (works for every provider via prompt injection) ----
  const tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null;
  const toolChoice = body.tool_choice;
  const useTools = Boolean(tools) && toolChoice !== 'none';
  const toolsInstruction = useTools ? buildToolsInstruction(tools, toolChoice) : null;

  const payload = buildPayload(provider, body, toolsInstruction);
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

  const parsed = useTools ? parseReply(reply) : { content: reply, toolCalls: null };

  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '');
  const created = Math.floor(Date.now() / 1000);
  const streaming = body.stream === true || body.stream === 'true';
  const outputForUsage = parsed.toolCalls ? JSON.stringify(parsed.toolCalls) : parsed.content;

  if (streaming) {
    return sendStream(req, res, {
      id,
      created,
      model: providerId,
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      includeUsage: Boolean(body.stream_options && body.stream_options.include_usage),
      usage: estimateUsage(body.messages, outputForUsage),
    });
  }

  const message = parsed.toolCalls
    ? { role: 'assistant', content: parsed.content || null, tool_calls: parsed.toolCalls }
    : { role: 'assistant', content: parsed.content };

  res.json({
    id,
    object: 'chat.completion',
    created,
    model: providerId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: parsed.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: estimateUsage(body.messages, outputForUsage),
  });
});

/** Stream `content` or `toolCalls` as OpenAI chat.completion.chunk events. */
function sendStream(req, res, { id, created, model, content, toolCalls, includeUsage, usage }) {
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

  const frames = buildStreamFrames(content, toolCalls);
  let i = 0;

  const tick = () => {
    if (closed) return;
    if (i >= frames.length) {
      if (includeUsage) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: usage || estimateUsage([], content || '') })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    write([frames[i++]]);
    if (STREAM_DELAY_MS > 0) setTimeout(tick, STREAM_DELAY_MS);
    else setImmediate(tick);
  };

  tick();
}

/** Build the ordered list of streamed choice deltas (content or tool_calls). */
function buildStreamFrames(content, toolCalls) {
  const frames = [];

  if (toolCalls && toolCalls.length > 0) {
    frames.push({
      index: 0,
      delta: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc, idx) => ({
          index: idx,
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: '' },
        })),
      },
      finish_reason: null,
    });

    toolCalls.forEach((tc, idx) => {
      for (const chunk of splitIntoChunks(tc.function.arguments, 8, 24)) {
        frames.push({
          index: 0,
          delta: { tool_calls: [{ index: idx, function: { arguments: chunk } }] },
          finish_reason: null,
        });
      }
    });

    frames.push({ index: 0, delta: {}, finish_reason: 'tool_calls' });
    return frames;
  }

  frames.push({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
  for (const chunk of splitIntoChunks(content)) {
    frames.push({ index: 0, delta: { content: chunk }, finish_reason: null });
  }
  frames.push({ index: 0, delta: {}, finish_reason: 'stop' });
  return frames;
}

module.exports = router;
