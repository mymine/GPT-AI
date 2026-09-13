'use strict';

/**
 * In-process invocation of an Express router.
 *
 * The OpenAI-compatible gateway needs to reuse the existing `/chat/vN`
 * scraper routers. Calling itself over HTTP (`http://127.0.0.1:PORT`) only
 * works when a server is actually listening — which is not the case on
 * serverless platforms such as Vercel, where the app is invoked per-request
 * with no bound port. This helper drives a router directly with a minimal
 * mock request/response, so no socket, port or network is involved.
 *
 * Returns a promise resolving to `{ statusCode, body }`, where `body` is the
 * parsed JSON payload (or the raw string) produced by the handler.
 */

const { EventEmitter } = require('events');

function parseBody(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'object' && !Buffer.isBuffer(payload)) return payload;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function invoke(handler, options = {}) {
  const method = (options.method || 'POST').toUpperCase();
  const url = options.url || '/';
  const headers = {};
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null) headers[key.toLowerCase()] = value;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    // ---- mock request ----
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.originalUrl = url;
    req.baseUrl = '';
    req.headers = headers;
    req.query = {};
    req.params = {};
    req.body = options.body;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = req.socket;
    req.get = (name) => headers[String(name).toLowerCase()];
    req.header = req.get;
    req.is = () => false;
    req.accepts = () => false;
    req.range = () => undefined;

    // ---- mock response ----
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.locals = {};
    res._headers = {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.setHeader = (name, value) => { res._headers[String(name).toLowerCase()] = value; return res; };
    res.getHeader = (name) => res._headers[String(name).toLowerCase()];
    res.removeHeader = (name) => { delete res._headers[String(name).toLowerCase()]; };
    res.set = res.setHeader;
    res.get = res.getHeader;
    res.writeHead = (code, extraHeaders) => {
      res.statusCode = code;
      if (extraHeaders && typeof extraHeaders === 'object') {
        for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      }
      return res;
    };
    res.write = () => true; // swallow any streaming writes
    res.json = (payload) => { res.headersSent = true; finish({ statusCode: res.statusCode, body: payload }); return res; };
    res.send = (payload) => {
      res.headersSent = true;
      finish({ statusCode: res.statusCode, body: parseBody(payload) });
      return res;
    };
    res.end = (payload) => {
      res.headersSent = true;
      if (payload === undefined) return finish({ statusCode: res.statusCode, body: null }), res;
      finish({ statusCode: res.statusCode, body: parseBody(payload) });
      return res;
    };

    const next = (err) => {
      if (err) return fail(err);
      finish({ statusCode: 404, body: { error: 'no matching route in scraper' } });
    };

    try {
      const ret = handler(req, res, next);
      if (ret && typeof ret.then === 'function') ret.catch(fail);
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = { invoke };
