/*
 * Randy — streaming answer proxy (edge function)
 * ----------------------------------------------
 * The browser's overheard-question answer call streams through here instead of
 * the Google Apps Script proxy (which physically can't stream). This mirrors
 * `handleChat_` in apps-script.gs — same Anthropic key, same `pause_turn`
 * continuation loop, same source extraction — but with `stream: true` and the
 * tokens forwarded to the browser as they arrive, collapsed into one tiny SSE
 * protocol the client understands:
 *
 *     data: {"type":"text","text":"…"}      incremental answer text
 *     data: {"type":"sources","sources":[…]} cited / searched URLs (once, at end)
 *     data: {"type":"usage","usage":{…}}     token + prompt-cache counts (at end)
 *     data: {"type":"error","error":"…"}     hard failure
 *     data: {"type":"done"}                  stream complete
 *
 * The classifier call, the background Sheet save, and history all stay on Apps
 * Script. Set the deployed URL of this function as STREAM_WEBHOOK in index.html
 * to turn streaming on; leave it empty to keep the current behaviour.
 *
 * ── DEPLOY (Cloudflare Workers — recommended, free tier) ──────────────────────
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy worker.js --name randy-stream --compatibility-date 2024-10-01
 *   3. wrangler secret put ANTHROPIC_API_KEY      # paste the sk-ant-… key
 *   4. (optional) set APP_ORIGIN to the app's exact origin to lock CORS:
 *        wrangler secret put APP_ORIGIN           # e.g. https://randy.example.com
 *   5. Put the resulting https://randy-stream.<you>.workers.dev URL into
 *      STREAM_WEBHOOK in index.html.
 *
 *   Vercel Edge / Deno Deploy work too — the body is Web-standard fetch +
 *   ReadableStream. On Vercel: `export const config = { runtime: 'edge' }` and
 *   read the key from process.env. On Deno: `Deno.serve(handler)` and
 *   Deno.env.get. The handler logic below is identical.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_CONTINUATIONS = 6;            // bound the pause_turn loop (matches Apps Script)
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOK = 1100;
const RETRYABLE = [408, 409, 429, 500, 502, 503, 504];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    if (request.method !== 'POST') return cors(json({ ok: false, error: 'POST only' }, 405), env);

    let body;
    try { body = await request.json(); }
    catch { return cors(json({ ok: false, error: 'Invalid JSON body' }, 400), env); }

    const key = env && env.ANTHROPIC_API_KEY;
    if (!key) return cors(sseResponse(oneShot({ type: 'error', error: 'No ANTHROPIC_API_KEY configured on the proxy.' })), env);

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (obj) => { try { controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch {} };
        try {
          await runChat(body, key, emit);
        } catch (e) {
          emit({ type: 'error', error: String((e && e.message) || e) });
        } finally {
          try { controller.close(); } catch {}
        }
      }
    });
    return cors(sseResponse(stream), env);
  }
};

// Drive one logical answer, stitching pause_turn continuations into a single
// downstream stream so the browser sees one uninterrupted trickle.
async function runChat(body, key, emit) {
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  const base = {
    model: String(body.model || DEFAULT_MODEL),
    max_tokens: Number(body.max_tokens) || DEFAULT_MAX_TOK,
    system: body.system || '',
    stream: true
  };
  if (Array.isArray(body.tools) && body.tools.length) base.tools = body.tools;
  if (body.output_config && typeof body.output_config === 'object') base.output_config = body.output_config;

  const sources = [];
  let usage = {};
  let stopReason = null;
  let continuations = 0;

  do {
    const upstream = await fetchAnthropicStream(Object.assign({}, base, { messages }), key);
    const leg = await pumpLeg(upstream, emit);
    stopReason = leg.stopReason;
    for (const u of leg.sources) if (u && sources.indexOf(u) === -1) sources.push(u);
    usage = mergeUsage(usage, leg.usage);
    if (stopReason === 'pause_turn') {
      messages = messages.concat([{ role: 'assistant', content: leg.content }]);
      continuations++;
    }
  } while (stopReason === 'pause_turn' && continuations < MAX_CONTINUATIONS);

  emit({ type: 'sources', sources });
  emit({ type: 'usage', usage });
  emit({ type: 'done' });
}

// One Anthropic streaming round trip with bounded retry on transient failures.
async function fetchAnthropicStream(payload, key) {
  let lastErr = 'Anthropic request failed';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) { lastErr = 'Network error: ' + String((e && e.message) || e); continue; }

    if (res.ok && res.body) return res;

    let msg = 'Anthropic API error (' + res.status + ')';
    try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch {}
    if (RETRYABLE.indexOf(res.status) === -1) throw new Error(msg);
    lastErr = msg;
  }
  throw new Error(lastErr);
}

// Parse one upstream Anthropic SSE leg: forward text deltas to the client,
// reconstruct the content blocks (needed to resume after pause_turn), and
// collect cited/searched source URLs and token usage. Mirrors extractReply_.
async function pumpLeg(upstream, emit) {
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const blocks = [];
  const sources = [];
  let stopReason = null;
  let usage = {};

  const handle = (event, data) => {
    if (event === 'message_start') {
      if (data.message && data.message.usage) usage = mergeUsage(usage, data.message.usage);
    } else if (event === 'content_block_start') {
      const cb = data.content_block || {};
      const b = Object.assign({}, cb);
      if (b.type === 'text') { b.text = b.text || ''; b.citations = b.citations || []; }
      if (b.type === 'server_tool_use') { b._json = ''; b.input = b.input || {}; }
      blocks[data.index] = b;
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const hit of b.content) if (hit && hit.url && sources.indexOf(hit.url) === -1) sources.push(hit.url);
      }
    } else if (event === 'content_block_delta') {
      const b = blocks[data.index];
      const d = data.delta || {};
      if (!b) return;
      if (d.type === 'text_delta' && d.text) { b.text += d.text; emit({ type: 'text', text: d.text }); }
      else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') { b._json += d.partial_json; }
      else if (d.type === 'citations_delta' && d.citation) {
        b.citations = b.citations || [];
        b.citations.push(d.citation);
        if (d.citation.url && sources.indexOf(d.citation.url) === -1) sources.push(d.citation.url);
      }
    } else if (event === 'content_block_stop') {
      const b = blocks[data.index];
      if (b && b.type === 'server_tool_use' && b._json) { try { b.input = JSON.parse(b._json); } catch {} delete b._json; }
    } else if (event === 'message_delta') {
      if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) usage = mergeUsage(usage, data.usage);
    } else if (event === 'error') {
      throw new Error((data && data.error && data.error.message) || 'Anthropic stream error');
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message', dataStr = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      let data;
      try { data = JSON.parse(dataStr); } catch { continue; }
      handle(event, data);
    }
  }

  const content = blocks.filter(Boolean).map(b => { const c = Object.assign({}, b); delete c._json; return c; });
  return { content, stopReason, sources, usage };
}

// Keep the input/cache counts from the first leg's message_start and sum output
// tokens across legs — enough for the client's cache-hit verification.
function mergeUsage(a, b) {
  if (!b) return a || {};
  const out = Object.assign({}, a);
  for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (typeof b[k] === 'number' && !out[k]) out[k] = b[k];
  }
  if (typeof b.output_tokens === 'number') out.output_tokens = (out.output_tokens || 0) + b.output_tokens;
  return out;
}

/* ---------- small HTTP helpers ---------- */

function sseResponse(body) {
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive'
    }
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

function oneShot(obj) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { c.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n')); c.close(); }
  });
}

function cors(resp, env) {
  const h = new Headers(resp.headers);
  h.set('access-control-allow-origin', (env && env.APP_ORIGIN) || '*');
  h.set('access-control-allow-methods', 'POST, OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  h.set('vary', 'origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
