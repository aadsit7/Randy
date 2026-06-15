# Randy — Latency Analysis & Improvement Plan

How to cut the ~15s "ask → spoken answer" delay **without weakening the persona,
the accuracy rules, the classifier gate, or the doc-grounding** that make the
answers trustworthy. Every recommendation below is a latency-engineering change,
not a quality change. The rules and guidelines stay exactly as they are.

---

## TL;DR

The single thing that makes Randy slow is **structural, not the rules**: the
Google Apps Script proxy cannot stream, so the browser receives *nothing* until
the model has finished generating the entire answer (and finished any web
searches). On top of that, the spoken summary is the **last** thing the model
writes (after the `===SPOKEN===` marker), so even the text you'd read aloud is
produced dead last.

> Industry target for a voice agent is **~800 ms** "you stop talking → I start
> talking," with **300–500 ms** feeling truly natural and **>1.2 s** feeling
> broken. Randy is at ~15 s — roughly 15–20× over. ([AssemblyAI](https://www.assemblyai.com/blog/low-latency-voice-ai),
> [Sierra](https://sierra.ai/blog/voice-latency))

The fix that preserves 100% of the quality: **stream the model's tokens to the
browser and start speaking the first sentence while the rest is still being
written**, and **reorder the answer so the spoken part comes first.** That alone
takes time-to-first-audio from ~15 s to roughly ~1–3 s. Everything else is
incremental on top.

---

## How the answer pipeline works today

Passive "technical-assist" path (the one that feels slow on a live call):

1. **Web Speech API** captures speech → interim + final transcripts.
2. `assistIngest()` buffers, then waits out a **silence gap** of `DEBOUNCE_MS`
   (1400 ms) / `DEBOUNCE_FAST_MS` (900 ms). *(intentional — don't cut a question
   in half)* — `index.html:1975`
3. `flushAssistBuffer()` decides to answer — `index.html:1985`
   - **Fast path:** a clearly-formed question (`isInstantTechQuestion`) goes
     straight to the answer, skipping the classifier. Good — already saves a
     round trip. — `index.html:2037`
   - **Otherwise:** `classifyUtterance()` makes a **Haiku round trip** through the
     proxy *before* the answer call. — `index.html:2109`
4. `runAssistAnswer()` makes the **Sonnet 4.6 call with the `web_search` tool**,
   `max_tokens: 1100`, `effort: medium`. — `index.html:2310`
5. The proxy (`apps-script.gs`) calls Anthropic with **`stream: false`** because
   "Apps Script can't stream back to the browser" (its own comment) and re-sends
   the whole conversation once per web search (`pause_turn` continuation). —
   `apps-script.gs:98`, `apps-script.gs:116`
6. Only when the **entire** answer is back does `splitSpoken()` pull the text
   after `===SPOKEN===` and `speakText()` finally speak it. — `index.html:2376`

### Where the ~15 seconds goes

| Stage | Typical cost | Notes |
|---|---|---|
| Silence debounce | 0.9–1.4 s | Intentional. Leave it (or tune slightly). |
| Classifier round trip | 0–2.5 s | Only on the non-fast path. Serial, blocking. |
| **Sonnet answer + web search** | **5–15 s** | The dominant cost. Their own code comment says "answers with web search take 5–15 s." |
| Apps Script proxy overhead | ~0.5–2 s | Per leg, and it's a serial extra hop (browser → Apps Script → Anthropic → back). Multiplied by each `pause_turn` continuation. |
| TTS start | ~instant | On-device browser voice. **Not** the bottleneck. |

The killer is that stages 4–5 are **fully serial and opaque**: nothing reaches
the user — not text, not audio — until the last token is generated. Streaming
turns that wall of waiting into a trickle that starts almost immediately.

---

## What the research says (and where Randy stands)

- **Conversational target:** ~800 ms voice-to-voice in production; 300–500 ms
  feels natural; users disengage past ~1.2 s. ([AssemblyAI](https://www.assemblyai.com/blog/low-latency-voice-ai),
  [WebRTC.ventures](https://webrtc.ventures/2025/10/slow-voicebot-how-to-fix-latency-in-voice-enabled-conversational-voice-ai-agents/))
- **Streaming is the headline technique.** Anthropic's own latency guide lists
  three levers: pick the right model, trim output length/`max_tokens`, and
  **stream**. Streaming "significantly improves perceived responsiveness."
  Benchmarks show first token in ~0.3–2 s, then 50–100 tokens/s — versus waiting
  for the whole thing. ([Anthropic](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency))
- **The canonical voice-agent pattern:** stream LLM tokens to TTS **at sentence
  boundaries** — "while the LLM is generating token 50, TTS has already spoken
  tokens 1–30." With streaming across STT/LLM/TTS, sub-1s end-to-end is
  achievable. ([AssemblyAI](https://www.assemblyai.com/blog/voice-agent-architecture),
  [LiveKit](https://livekit.com/blog/voice-agent-architecture-stt-llm-tts-pipelines-explained))
- **Sierra (production voice agents):** the metric that matters is **Time To
  First Audio**; key tactics are **parallel execution** (run retrieval/checks
  alongside generation), **predictive prefetch**, and for speech: **stream audio
  as tokens arrive**, cache frequent phrases, and batch sentence-by-sentence for
  non-streaming providers. ([Sierra](https://sierra.ai/blog/voice-latency))
- **Modern streaming TTS is fast and natural** — time-to-first-audio of
  ~155–315 ms: Cartesia Sonic-3 ~188 ms, ElevenLabs Flash/Turbo ~264–288 ms,
  Deepgram Aura-2 ~313 ms. These are far more natural than the browser's built-in
  voice and still fast enough for live conversation. ([Gradium/Coval benchmark](https://gradium.ai/content/tts-latency-benchmark-2026),
  [AssemblyAI TTS APIs](https://www.assemblyai.com/blog/top-text-to-speech-apis))

---

## Recommendations, in priority order

Tagged by **quality impact** — note that the top items are **pure latency wins
with zero change to what Randy says or how carefully he says it.**

### P0 — Stream the answer + put the spoken part first  *(quality: none — same model, same prompt, same search)*

This is the whole ballgame. Two changes that go together:

1. **Replace the non-streaming proxy with a streaming-capable one.** Apps Script
   physically can't stream (it runs `doPost` to completion and returns one body;
   that's why `stream: false` is hardcoded). Swap it for a tiny edge function
   that supports SSE pass-through — **Cloudflare Workers, Vercel Edge, or Deno
   Deploy** — holding the same Anthropic key and doing the same `pause_turn`
   continuation logic, but with `stream: true` and the bytes forwarded to the
   browser as they arrive. The browser reads the SSE stream and feeds the
   **existing** TTS sentence queue (`enqueueTtsSentence`, `processTtsQueue` —
   already built at `index.html:1340`) as each sentence completes.
   - *Keep the Apps Script endpoint for the background Sheet logging* — that part
     works fine off the critical path. Only the chat call needs to move.
2. **Reorder the assist output to "spoken-first."** Today `ASSIST_STYLE` emits
   `Bottom line:` → bullets → `===SPOKEN===` → spoken summary, so the audio text
   is generated last (`index.html:496`). Flip it: have the model emit the 2–3
   sentence spoken summary **first**, then the bullets. With streaming, Randy
   starts talking after the first ~15–30 tokens (~1–2 s) while the detailed
   bullets keep filling into the chat panel behind the voice. **No rule is
   dropped — only the order of the same content changes.**

**Expected impact:** time-to-first-audio ~15 s → **~1–3 s** for answers that
don't need a live search; the search delay (below) is the remaining tail.

### P1 — Take web search off the live critical path  *(quality: neutral-to-better)*

Web search is the single slowest sub-step, and each search is another full,
non-streamed round trip. The grounding it provides is important — so don't remove
it, **make it local and instant** for the docs Randy already trusts:

- **Pre-index the known doc domains** (`docs.recastsoftware.com`,
  `docs.liquit.com`, `recastsoftware.com`, `learn.microsoft.com`) into a small
  embedded knowledge store and retrieve locally (RAG) instead of live-searching
  on every call. Curated retrieval is typically **faster and more reliable** than
  live web search — so this can *raise* accuracy while cutting seconds.
- Keep live `web_search` as the fallback for genuinely fresh/out-of-corpus
  questions. The tool is already model-discretionary (it only fires when the
  model decides it needs it), so this is purely about making the common case
  fast.

**Expected impact:** removes the 5–15 s search tail for product-fact questions —
the bulk of a Recast SE call.

### P2 — Natural-sounding voice  *(quality: better; tradeoff: cost + small network latency)*

The "sound more human" ask is mostly a **TTS-engine** question, separate from
answer latency. The browser's `speechSynthesis` is zero-latency but robotic and
varies wildly by machine. A streaming neural voice (Cartesia Sonic, ElevenLabs
Flash, Deepgram Aura) sounds markedly more human and still hits first audio in
~150–300 ms — fast enough for live use. Fed by the P0 token stream, it speaks
each sentence as it lands.

- Keep the excellent `TTS_LEXICON` pronunciation work (`index.html:1159`) — feed
  the same cleaned text to the cloud voice.
- Keep browser TTS as an offline/no-key fallback.

### P3 — Smaller, safe wins  *(quality: none)*

- **Parallelize the classifier with a speculative answer.** On the non-fast path,
  start the Sonnet answer *and* the Haiku classifier at the same time; if the
  classifier says "not a question," abort the answer (the `AbortController`
  plumbing already exists). Removes the classifier from the serial path without
  loosening the gate. — `index.html:2045`
- **Confirm prompt-cache hits.** The persona prefix is already wrapped for
  caching (`systemBlocks`, `index.html:2192`) — verify the cached block is
  byte-identical call-to-call so the ~2K-token persona isn't reprocessed each
  time (saves input-processing latency on every turn). Anthropic ephemeral cache
  TTL is ~5 min, so on an active call it stays warm.
- **Instrument Time-To-First-Audio.** There's no timing today. Log the four
  stages above so regressions are visible — Sierra's point: "you can't shave
  milliseconds you can't see."
- **Tune the debounce** only after the above — at ~900–1400 ms it's a meaningful
  slice once the rest is fast, but it's there to avoid cutting questions off, so
  shorten it carefully (and the `DEBOUNCE_FAST_MS` fast path already helps).

---

## Suggested sequencing

1. **P0** first — it's the 10×, and it touches no rules. Stand up a streaming
   edge proxy, wire the browser to read SSE into the existing TTS queue, and flip
   the assist format to spoken-first.
2. **P1** next — pre-index the docs so grounded answers don't pay the live-search
   tax.
3. **P2** if you want the voice itself to sound more human (cost/latency
   tradeoff to weigh).
4. **P3** to clean up the tail and keep it fast.

None of these skip the persona, the accuracy rules, the classifier gate, or the
doc grounding. They change *when and how the same answer is delivered*, not
*what* it is.
