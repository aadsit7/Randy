# Randy — Streaming Answer Proxy (design sketch)

The single biggest latency lever, written up so the "one more moving part vs. the
10×" decision can be made on facts. **No app code changes ship with this doc** —
it's the design for the change `LATENCY.md` calls **P0**, grounded in how the
pipeline actually works today.

> **Why this exists:** every other quality-neutral win is already shipped (fast
> path, persona prompt-caching, proxy warm-up, preconnect, latency
> instrumentation). What's left is structural: the Apps Script proxy **cannot
> stream**, so the browser gets *nothing* — no text, no audio — until the entire
> answer (and every web search) is done. That's the ~15 s wall. Streaming is the
> only way through it **without trading model, prompt, search, or gate quality.**

---

## 1. The constraint, precisely

`apps-script.gs` hardcodes `stream: false` with the comment *"Apps Script can't
stream back to the browser."* That's correct and unfixable in place: Apps Script
runs `doPost` to completion and returns one body — there is no `ReadableStream`,
no SSE, no flushing partial output. You also can't fake it by polling, because the
upstream Anthropic call is a single synchronous `UrlFetchApp.fetch` that returns
only when generation is fully done; there are no partials to poll for.

So the answer text exists token-by-token **inside Anthropic**, but the only path
to the browser collapses it back into one blob. The job is to put a relay on that
path that keeps it a stream.

## 2. What gets built

A tiny **edge function** (V8 isolate / serverless) that does exactly what
`handleChat_` does today — holds the Anthropic key, runs the `pause_turn`
continuation loop, enforces the domain allow-list — **but with `stream: true` and
the SSE bytes forwarded to the browser as they arrive.**

```
  Today:   browser ──POST──▶ Apps Script ──fetch(stream:false)──▶ Anthropic
                    ◀─ one JSON blob, ~5–15 s later ──────────────┘

  Proposed: browser ──POST──▶ Edge fn ──fetch(stream:true)──▶ Anthropic
                     ◀═ SSE trickle, first token ~0.3–2 s ═══════┘
                    (Apps Script stays — for the background Sheet save only)
```

Crucially, this is **not a rewrite** — it's the same request shape. The edge
function is ~120 lines that mirror `handleChat_`:

```js
// edge function (Cloudflare Worker / Vercel Edge / Deno — all support streaming)
export default async function (req) {
  const body = await req.json();                  // same payload the client sends today
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,                 // secret/env var, never shipped to the client
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ...body, stream: true })
  });
  // Forward the SSE stream straight through; handle pause_turn continuation
  // server-side (see §4) so the browser sees ONE continuous stream.
  return new Response(streamWithContinuation(upstream, body), {
    headers: {
      'content-type': 'text/event-stream',
      'access-control-allow-origin': APP_ORIGIN   // lock to the app's origin
    }
  });
}
```

## 3. The browser side

`postChat()` stays for the classifier (a tiny JSON call — streaming buys it
nothing) and for the background save. The **answer** call in `runAssistAnswer()`
switches to a streaming reader that feeds the machinery the app *already has*:

- **Visual:** append text deltas to the assistant message as they arrive →
  `render()` shows the answer forming in ~1–2 s instead of a 15 s spinner.
- **Audio:** the sentence-by-sentence TTS queue is already built and battle-
  tested — `enqueueTtsSentence()` / `processTtsQueue()`, plus the echo guard
  (`appendRecentTts`, `isLikelyEcho`). Stream-side, you just split the spoken
  text on sentence boundaries and enqueue each completed sentence. The TTS layer
  doesn't change at all.

```js
const res = await fetch(STREAM_WEBHOOK, { method: 'POST', body: JSON.stringify(payload), signal });
const reader = res.body.getReader();
const dec = new TextDecoder();
let full = '', spokenBuf = '', inSpoken = false;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const delta of parseSseTextDeltas(dec.decode(value, { stream: true }))) {
    full += delta;
    perfMark(perf, full.length && !perf.marks.firstToken ? 'firstToken' : '_');  // PR #62 harness, ready for this
    msg.content = renderPartial(full);            // visual stream into the panel
    // once past the ===SPOKEN=== marker, feed whole sentences to the existing queue
    [spokenBuf, inSpoken] = pumpSpokenSentences(full, spokenBuf, inSpoken, (sentence) => {
      perfMark(perf, 'firstAudio');               // now a REAL measurement
      enqueueTtsSentence(idx, sentence);
    });
  }
}
```

The `PERF` instrumentation from the last PR is already positioned for this — once
streaming lands, `firstToken` and `firstAudio` become true measurements instead of
"answer fully done" timestamps, so you can prove the win.

## 4. The one genuinely fiddly part: `pause_turn` while streaming

Server tools (web_search) can pause a long turn; today `handleChat_` loops,
re-sending the assistant turn until `stop_reason !== 'pause_turn'`
(`apps-script.gs:116`). In the streaming version this loop lives in the edge
function and **stitches multiple upstream streams into one downstream stream**:

```
  forward deltas ─▶ upstream ends with stop_reason=pause_turn
                 ─▶ edge fn appends the partial assistant turn, re-requests (stream:true)
                 ─▶ keeps forwarding deltas on the SAME response to the browser
                 ─▶ repeat until a non-pause stop_reason (bounded, like MAX_CONTINUATIONS today)
```

The browser sees one uninterrupted trickle. This is the part to get right and
test; everything else is plumbing. (Note: because grounding comes from
**web_search results landing in context**, not from chain-of-thought, the model
already has its facts before it writes a word — see §6 on why spoken-first costs
little.)

## 5. Rollout — zero-risk, reversible

Gate it on a single constant so it's a flip, not a migration:

```js
const STREAM_WEBHOOK = '';   // empty = use the current Apps Script path unchanged
```

- Empty / not configured → the app behaves **exactly as it does today**.
- Set → the answer call streams; on any stream error, **fall back** to the
  existing `postChat()` Apps Script path for that request.
- The classifier, the background save (`postSaveToSheet`), history, and the
  config ping all stay on Apps Script untouched.

So you can deploy the edge function, point one constant at it, and roll back by
blanking the constant. Nothing else in the app is load-bearing on it.

## 6. Quality: what stays identical, and the one honest asterisk

**Identical:** model (`MODELS.assist`), system prompt (`systemBlocks(persona +
ASSIST_STYLE)`), `web_search` tool, `allowed_domains`, `max_tokens`, `effort:
medium`, the gate, the dedupe, the echo guard. Same request, same answer — only
delivered as a stream. Even prompt-caching keeps working (the cache breakpoint is
on the system block, independent of `stream`).

**The asterisk — output order.** To make *audio* start fast (not just the visible
panel), the spoken summary should come **first**, before the bullets — today it's
last, after `===SPOKEN===`. Two honest options:

| Option | First audio | Quality note |
|---|---|---|
| **A. Reorder to spoken-first** | ~1–2 s | The model commits to a 2–3 sentence spoken answer before writing bullets. Because Randy's depth comes from **retrieved** web_search facts already in context — not from "thinking out loud" in the bullets — this costs very little. Recommended. |
| **B. Keep order, TTS the "Short answer:" line as it streams** | ~1–2 s | No reorder; preserves the hand-tuned `===SPOKEN===` block exactly. But the first thing spoken is the *written* one-liner, which is a hair less conversational than the spoken block. |
| **C. Keep order, stream visual only** | unchanged audio | Zero quality question at all; the panel fills in ~1–2 s but audio still waits for the spoken block near the end. A safe partial win. |

My recommendation: **A**, with **C** as the trivially-safe fallback if you want to
ship the visual win first and decide on audio ordering separately.

## 7. Bonus: the proxy hop gets cheaper too

Independent of streaming, edge isolates cold-start in **~5 ms** vs Apps Script's
**0.5–2 s**, and there's no Sheets/`SpreadsheetApp` runtime attached to the chat
path. So even the per-leg overhead in the table in `LATENCY.md` shrinks — and the
warm-up ping/keep-alive that exists for Apps Script is no longer needed for the
chat call.

## 8. Hosting options (all have free tiers — no subscription required)

| Platform | Streaming | Free tier | Notes |
|---|---|---|---|
| **Cloudflare Workers** | ✅ native | 100k req/day | Fastest cold start; `env` secrets; simplest SSE pass-through. **Default pick.** |
| **Vercel Edge Functions** | ✅ | generous hobby | Nice if you already use Vercel; streaming `Response` supported. |
| **Deno Deploy** | ✅ | generous | Straight Web-standard `fetch`/`ReadableStream`; least boilerplate. |

All three: hold the key as a secret env var (strictly better than today, where the
key sits in an Apps Script the webhook URL fronts), lock CORS to the app origin,
and optionally add a shared header/token to blunt abuse of the public endpoint.

## 9. Effort & risk

- **Effort:** ~120 lines edge fn + ~100 lines browser streaming reader/sentence
  pump. The TTS queue, echo guard, render path, and PERF marks already exist.
  Realistically a focused day, plus testing the `pause_turn` stitching.
- **Risk:** low and contained — feature-flagged with a live fallback to the
  current path; the classifier and save paths don't move. The one thing to test
  hard is the multi-leg `pause_turn` stream stitching (§4).
- **Expected impact:** time-to-first-audio **~15 s → ~1–3 s** for non-search
  answers; for search answers the panel fills immediately and audio starts as
  soon as the spoken sentences stream, instead of after the whole multi-search
  turn completes.

---

## 10. Recommended sequencing

1. Stand up the edge function (Cloudflare Worker) mirroring `handleChat_` with
   `stream: true` + the `pause_turn` continuation loop.
2. Add `STREAM_WEBHOOK` + the streaming reader in `runAssistAnswer()`, **Option C
   first** (visual stream only) — ships the perceived-latency win with zero
   quality question and exercises the whole path end-to-end.
3. Turn on **Option A** (spoken-first) for fast audio once C is proven.
4. Read the real `firstToken` / `firstAudio` numbers off `window.__randyPerf` to
   confirm the win and catch regressions.

None of this touches the persona, the accuracy rules, the classifier gate, or the
doc-grounding. It changes *when and how* the same answer arrives — not *what* it is.
