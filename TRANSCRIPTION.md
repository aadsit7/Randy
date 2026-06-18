# Randy — Listening & Transcription Accuracy

How Randy turns what he hears on a call into clean text, and the changes that
make that text **world-class accurate without changing how the tool behaves**.
This is the speech-to-text companion to `QUESTION-UNDERSTANDING.md` (which covers
deciding *whether* a transcript is a question worth answering) and `LATENCY.md`
(which covers *how fast* the answer comes back).

> **Status (2026-06):** the changes in §3 are **shipped** in `index.html`. They
> are accuracy-only — no new dependencies, no new permissions, no model
> re-download, and the quiet-room behaviour is byte-for-byte the same as before.

---

## 1. The two listening channels

Randy hears on two independent paths, both feeding the same pipeline
(`handleVoiceTranscript` / `updateInterim`):

| Channel | Engine | Used for |
|---|---|---|
| **Microphone** | Web Speech API (`SpeechRecognition`, Chrome/Edge cloud STT) | the user's own voice, and — in two-way mode, with echo cancellation/noise-suppression/AGC **off** — the call overheard acoustically off the speakers |
| **Computer audio** | In-browser Whisper (`whisper-base.en`, WebGPU → WASM) over `getDisplayMedia` | the call captured **digitally**, so it works on headphones too; nothing leaves the browser |

The Web Speech engine is a black box we can't tune; the Whisper path is fully
ours, so it's where most of the accuracy headroom lives.

## 2. Where accuracy was leaking

1. **Whisper hallucinations on non-speech.** Fed near-silence, music, or room
   tone, Whisper invents stock phrases — "Thank you.", "you", "Thanks for
   watching" — which Web Speech never produces. A hallucinated line can
   debounce-flush as if it were a real utterance.
2. **Repetition loops.** Greedy Whisper decoding occasionally loops a word or
   short clause ("patching patching patching…") until the segment ends.
3. **Clipped word onsets.** The old detector only started buffering audio once a
   block already crossed the energy threshold, so the first phoneme of the first
   word was lost — and Whisper mis-reads clipped starts.
4. **A fixed silence threshold.** One hard-coded RMS cutoff can't tell a quiet
   speaker from a noisy room: it either transcribes the HVAC hum (→ hallucinations)
   or, raised globally, misses soft speech.
5. **Mid-word splits.** A single sub-threshold dip mid-sentence could end the
   segment early, cutting a question in half.

## 3. What shipped

All in `index.html`, all accuracy-only.

- **Hallucination + repetition scrubbing** (`sanitizeAsrText`). Every Whisper
  result is cleaned before it's treated as speech: immediate word repeats and
  looped short clauses are collapsed, and an output that is *entirely* a known
  silence hallucination is dropped. Real questions that merely contain those
  words pass through untouched.
- **Anti-repetition decoding.** The Whisper worker now decodes with
  `no_repeat_ngram_size: 3` (greedy, `num_beams: 1` — still fast for live use),
  which prevents the loop at the source.
- **Adaptive dual-threshold VAD** (`processDesktopBlock`). A noise floor is
  tracked while the line is quiet; the segment **opens** only above
  `noiseFloor × 1.8` (or the fixed `SILENCE_RMS` floor, whichever is higher) and
  stays open until it drops below the lower `noiseFloor × 1.3` close threshold.
  The gap gives **hysteresis** (no more mid-word splits); the floor is clamped so
  a loud room can never raise the bar past real speech. In a silent room the open
  threshold stays pinned to the original `SILENCE_RMS`, so existing behaviour is
  unchanged.
- **Onset pre-roll.** ~300 ms of pre-onset audio is kept in a ring buffer and
  prepended when a segment opens, so the first word survives intact.
- **Wider domain corrections** (`TRANSCRIPT_FIXES`). More endpoint-management
  garbles are canonicalised (SCCM, MECM, PowerShell, Win32, Azure AD, Group
  Policy, hybrid join, plus the existing Intune/ConfigMgr/Recast/Liquit set), and
  the **live transcript band** now shows the corrected wording as it streams
  ("Intune", not "in tune"). Echo/dedupe and the answer pipeline still key off the
  raw transcript — the correction is display + downstream-answer polish only.

## 4. Deliberately left alone (and why)

- **The Whisper model stays `whisper-base.en`.** A larger model (`small.en`) is
  more accurate but forces a fresh multi-hundred-MB download and slower
  per-segment inference — a real "feels broken" risk on the first call. The
  decoding/VAD/scrubbing wins above lift base.en's real-world accuracy without
  that cost. Revisit only if a labelled eval shows a gap base.en can't close.
- **The Web Speech (mic) decoder is untouched** — it's a cloud black box. The
  scrubbing is Whisper-only so the mic path behaves exactly as before.

## 5. If you want to go further

- **Domain biasing for Whisper.** An initial-prompt / `prompt_ids` seed of the
  product vocabulary would bias decoding toward jargon at the source. Skipped for
  now because Transformers.js doesn't expose it cleanly through the ASR pipeline;
  worth revisiting if that changes.
- **A labelled eval set.** Pull real call utterances and measure WER per channel
  so future model/threshold changes are provable rather than vibes — the same
  prerequisite §3a of `QUESTION-UNDERSTANDING.md` calls for on the classifier.
