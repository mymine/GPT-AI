'use strict';

/**
 * Tool-calling support for the OpenAI-compatible gateway.
 *
 * Most of this project's backends (v3..v15) are plain web-chat proxies with no
 * native function-calling API. To make **every** provider support OpenAI
 * `tools`, the gateway:
 *
 *   1. renders the client's `tools` into a system instruction that asks the
 *      model to emit a single JSON object when it wants to call functions;
 *   2. rewrites `tool` / `tool_calls` messages into plain text so any backend
 *      can understand the conversation;
 *   3. parses the model's reply back into a standard OpenAI `tool_calls` array.
 *
 * Execution of the tool is left to the client — the gateway only carries the
 * call back and forth, exactly as asked.
 */

const { randomUUID } = require('crypto');

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

function newCallId() {
  return 'call_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

/** True if the conversation already contains tool-related messages. */
function hasToolMessages(messages) {
  return (messages || []).some(
    m => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0))
  );
}

/**
 * Build the system instruction that teaches a plain-chat backend how to emit
 * tool calls. `toolChoice` may force/forbid calls.
 */
function buildToolsInstruction(tools, toolChoice) {
  const specs = (tools || []).map(t => {
    const fn = (t && t.function) || t || {};
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    };
  });

  const lines = [
    'You can call the following functions (tools) to help the user.',
    'When you decide to call one or more functions, respond with ONLY a single JSON object, with no prose and no markdown fences, in exactly this shape:',
    '{"tool_calls":[{"name":"<function_name>","arguments":{<arguments_object>}}]}',
    'Rules:',
    '- "arguments" MUST be a JSON object matching the function parameters.',
    '- You MAY include several entries in "tool_calls" to call several functions at once.',
    '- After calling a function you will receive its result and can continue.',
    '- If no function call is needed, reply normally in plain text.',
  ];

  if (toolChoice === 'required') {
    lines.push('- You MUST call at least one function in this reply.');
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    lines.push(`- You MUST call the function "${toolChoice.function.name}" in this reply.`);
  }

  lines.push('', 'Available functions:', JSON.stringify(specs, null, 2));
  return lines.join('\n');
}

/** Render an assistant `tool_calls` list as a readable text fragment. */
function renderToolCalls(toolCalls) {
  return toolCalls
    .map(tc => {
      const fn = (tc && tc.function) || {};
      return `${fn.name || 'function'}(${fn.arguments || ''})`;
    })
    .join(', ');
}

/**
 * Normalise an OpenAI message array for a backend that takes `messages`
 * (system/user/assistant). Tool messages become plain text turns.
 */
function normalizeMessages(messages, toolsInstruction) {
  const out = [];
  if (toolsInstruction) out.push({ role: 'system', content: toolsInstruction });

  for (const m of messages || []) {
    if (!m) continue;

    if (m.role === 'tool') {
      const text = contentToText(m.content);
      out.push({ role: 'user', content: `[Tool result] ${text}` });
      continue;
    }

    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const base = contentToText(m.content);
      const calls = renderToolCalls(m.tool_calls);
      out.push({
        role: 'assistant',
        content: `${base ? base + '\n' : ''}[Called tools: ${calls}]`,
      });
      continue;
    }

    out.push({
      role: ['system', 'user', 'assistant', 'developer'].includes(m.role) ? m.role : 'user',
      content: contentToText(m.content),
    });
  }
  return out;
}

/**
 * Collapse an OpenAI message array into a single prompt string, rewriting
 * tool messages into readable lines. Prepends the tools instruction if given.
 */
function flattenMessages(messages, toolsInstruction) {
  const systems = [];
  const turns = [];
  let onlyUserText = null;

  for (const m of messages || []) {
    if (!m) continue;

    if (m.role === 'system') {
      const t = contentToText(m.content).trim();
      if (t) systems.push(t);
      continue;
    }

    if (m.role === 'tool') {
      const t = contentToText(m.content).trim();
      turns.push(`Tool result: ${t}`);
      onlyUserText = null;
      continue;
    }

    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const base = contentToText(m.content).trim();
      turns.push(`Assistant: ${base ? base + ' ' : ''}[Called tools: ${renderToolCalls(m.tool_calls)}]`);
      onlyUserText = null;
      continue;
    }

    const t = contentToText(m.content).trim();
    if (!t) continue;
    turns.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${t}`);
    onlyUserText = m.role === 'assistant' ? null : t;
  }

  // Shortcut: a single plain user message with no system/tools context.
  if (!toolsInstruction && systems.length === 0 && turns.length === 1 && onlyUserText !== null) {
    return onlyUserText;
  }

  const parts = [];
  if (toolsInstruction) parts.push(toolsInstruction);
  if (systems.length) parts.push(systems.join('\n'));
  if (turns.length) parts.push(turns.join('\n'));
  return parts.join('\n\n').trim();
}

/** Extract the first balanced JSON object from a string. */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse a model reply into tool calls. Returns `{ content, toolCalls }`.
 * `toolCalls` is a normalised OpenAI array (or null when it is a normal answer).
 */
function parseReply(reply) {
  const raw = String(reply || '');
  if (!raw.trim()) return { content: raw, toolCalls: null };

  let candidate = raw.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) candidate = fence[1].trim();

  const obj = extractJsonObject(candidate);
  if (!obj || typeof obj !== 'object') return { content: raw, toolCalls: null };

  let calls = null;
  if (Array.isArray(obj.tool_calls)) calls = obj.tool_calls;
  else if (obj.tool_call) calls = [obj.tool_call];
  else if (typeof obj.name === 'string' && (obj.arguments !== undefined || obj.parameters !== undefined)) calls = [obj];

  if (!calls || calls.length === 0) return { content: raw, toolCalls: null };

  const normalized = calls
    .map(c => {
      const fn = (c && c.function) || c || {};
      const name = fn.name;
      let args = fn.arguments !== undefined ? fn.arguments : fn.parameters;
      if (args === undefined || args === null) args = {};
      if (typeof args !== 'string') args = JSON.stringify(args);
      return {
        id: (c && c.id) || newCallId(),
        type: 'function',
        function: { name, arguments: args },
      };
    })
    .filter(c => typeof c.function.name === 'string' && c.function.name);

  if (normalized.length === 0) return { content: raw, toolCalls: null };

  // Any leading prose before the JSON is intentionally dropped.
  return { content: '', toolCalls: normalized };
}

module.exports = {
  contentToText,
  hasToolMessages,
  buildToolsInstruction,
  normalizeMessages,
  flattenMessages,
  parseReply,
  newCallId,
};
