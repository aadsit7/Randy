# Visual Question Recognition — Implementation Plan

Add a second input path to Randy: capture a frame of the **already-shared
screen/tab**, recognize a question in it with a **vision model (Claude)**, and
feed that question into the **same answer pipeline** the microphone and
computer-audio paths already use.

> **Status (2026-06):** **shipped** in `index.html`. The shared screen's video
> track is now retained (was discarded), a "Read screen" button + `Alt+Shift+R`
> hotkey grab one frame, a Claude vision call (`SCREEN_VISION_SYSTEM` /
> `SCREEN_VISION_SCHEMA`, on the Haiku classifier model) extracts a clean
> question, and it is answered through the existing `runAssistAnswer` path —
> the same chat spoken questions use. No backend change was needed: the proxy
> already forwards image content blocks to Anthropic verbatim. Region-select
> crop (§3c) is the remaining fast-follow. Decisions locked: source = the
> shared screen; recognition = Claude vision.

---

## 1. Why this is a small change

Three pieces of the existing architecture do almost all the work already:

1. **The video is already being captured and then thrown away.**
   `startDesktopCapture()` requests `video` from `getDisplayMedia()` at a tiny
   1 fps / 640×360 (`index.html:2467`), then immediately stops the video track
   (`index.html:2488`) because only audio was ever wanted. The screen feed we
   need for visual recognition is *already flowing in* — we just stop
   discarding it.

2. **The answer pipeline already takes a plain string.** A recognized question
   is handed to `enqueueQuestion(text)` (`index.html:2758`) →
   `drainQuestionQueue()` → `processAssistCandidate()` (`index.html:2840`) →
   `runAssistAnswer()` (`index.html:3229`). The same dedup, classifier,
   queueing, archive-to-history, speak-answer and source-rendering all apply
   with zero new logic. A screen question lands in the **same chat** as a
   spoken one.

3. **The proxy already forwards `messages` verbatim to Anthropic.**
   `apps-script.gs:102` passes `messages` straight through, and the answer
   model is `claude-sonnet-4-6` (`MODELS.assist`, `index.html:524`), which is
   vision-capable. So an Anthropic **image content block** can be sent through
   the existing `postChat()` (`index.html:3045`) with **no backend change** to
   the chat flow. The only backend touch is widening the model allow-list (§5).

What's genuinely new is therefore narrow: **keep the video track, grab a
frame, send it to a vision model to extract the question, drop the result into
the queue.**

---

## 2. User-facing flow

1. User is already capturing computer audio (the share is live, `DESKTOP.on`).
2. A new **"Capture question from screen"** control appears next to the
   computer-audio status strip (`index.html:3624` / `3698`) and on a hotkey.
3. On click:
   - grab one frame from the retained video track,
   - (optional) let the user drag a box over the region with the question,
   - show a brief "Reading screen…" status in the same strip via
     `setDesktopStatus()` (`index.html:2449`),
   - send the frame to Claude vision, get back a clean question string,
   - `enqueueQuestion(question)` — the answer streams into the normal chat.
4. If no question is found in the frame, a toast says so and nothing is queued.

No new screen-share prompt is needed — we reuse the surface the user already
picked. (If the share is audio-only because the user shared a *window* without
video, see §6.)

---

## 3. Changes in `index.html`

### 3a. Stop discarding the video track
In `startDesktopCapture()`, the video track is currently stopped at
`index.html:2488`. Instead, **retain the first video track** on the `DESKTOP`
state and only stop it in `stopDesktopCapture()` (`index.html:2671`, which
already stops all stream tracks, so teardown is covered). The 1 fps / low-res
constraint already in the `getDisplayMedia` call keeps this nearly free — the
same reason the original code chose those constraints.

Add to the `DESKTOP` object (`index.html:959`):

```js
videoTrack: null,      // retained for frame grabs (was stopped immediately)
imageCapture: null,    // ImageCapture wrapper, lazily created
visionBusy: false,     // single-flight gate for screen-question capture
```

### 3b. Grab a frame
Prefer `ImageCapture.grabFrame()` where available; fall back to drawing the
track into an offscreen `<canvas>` via a hidden `<video>` element (Safari /
older Chromium lack `ImageCapture`). Downscale the longest edge to ~1200 px and
encode JPEG ~0.7 quality — enough for the model to read UI text, small enough
to keep the upload and token cost down.

```js
async function grabDesktopFrame() {
  const track = DESKTOP.videoTrack;
  if (!track || track.readyState !== 'live') return null;
  let bitmap;
  if ('ImageCapture' in window) {
    DESKTOP.imageCapture = DESKTOP.imageCapture || new ImageCapture(track);
    bitmap = await DESKTOP.imageCapture.grabFrame();
  } else {
    bitmap = await grabViaHiddenVideo(track); // canvas fallback
  }
  return bitmapToJpegBase64(bitmap, 1200, 0.7); // → { data, mediaType }
}
```

### 3c. Optional region select
A lightweight drag-to-box overlay over a still of the frame lets the user crop
to just the question before recognition. Cropping improves accuracy and cuts
tokens. **Ship without it first** — full-frame recognition with a good prompt
is enough for v1; add the crop overlay as a fast follow.

### 3d. Recognize the question (Claude vision)
Reuse `postChat()` (`index.html:3045`) with an image block. Use the **classifier
model** (`claude-haiku-4-5`, `MODELS.classifier`) for the extraction step — it
is cheap, fast, and only has to read text and decide if there's a question.
This keeps the expensive Sonnet call for the actual answer.

```js
async function recognizeScreenQuestion() {
  if (DESKTOP.visionBusy || !DESKTOP.on) return;
  DESKTOP.visionBusy = true;
  setDesktopStatus('Reading screen…');
  try {
    const frame = await grabDesktopFrame();
    if (!frame) { showToast('No screen frame available to read.'); return; }
    const data = await postChat({
      model: MODELS.classifier,
      max_tokens: 200,
      system: systemBlocks(SCREEN_VISION_SYSTEM),
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64',
            media_type: frame.mediaType, data: frame.data } },
        { type: 'text', text: 'Extract the single technical question on screen.' }
      ]}],
      save: false
    });
    const q = parseScreenQuestion(data.reply); // JSON: { found, question }
    if (q && q.found && q.question) enqueueQuestion(q.question);
    else showToast('No question found on the shared screen.');
  } catch (err) {
    showToast('Randy could not read the screen — try again.');
  } finally {
    DESKTOP.visionBusy = false;
    setDesktopStatus(DESKTOP.on ? 'Computer audio: on' : '');
  }
}
```

`SCREEN_VISION_SYSTEM` is a short prompt mirroring `CLASSIFIER_SYSTEM`'s scope
rules (see `QUESTION-UNDERSTANDING.md`): "Read the screen. If there is a
technical question in scope (Recast / endpoint / Intune / ConfigMgr / …),
return `{found:true, question:'<clean, context-independent question>'}`,
otherwise `{found:false}`. Normalize OCR noise the same way garbled speech is
normalized." Because the extracted string then flows through
`processAssistCandidate()`, the existing classifier gives it a **second** scope
check before any expensive answer — so an accidental capture of off-topic text
is filtered just like off-topic speech.

### 3e. UI + input wiring
- Add a small button in the computer-audio status strip (`index.html:3624`,
  `3698`), shown only when `DESKTOP.on`. Give it a `data-action`
  (e.g. `capture-screen-question`) and handle it in the existing delegated
  click handler.
- Add a keyboard shortcut (e.g. `Ctrl/Cmd+Shift+Q`) for hands-free capture
  mid-call, gated on `DESKTOP.on`.
- Reflect `visionBusy` by disabling the button and showing the "Reading
  screen…" status so double-taps can't stack calls (the `visionBusy` gate is
  the real guard).

### 3f. Teardown
`stopDesktopCapture()` (`index.html:2671`) already stops every track on the
stream, so the retained video track is torn down for free. Just null out the
new fields (`videoTrack`, `imageCapture`, `visionBusy`) alongside the existing
resets at `index.html:2686`.

---

## 4. What is explicitly NOT needed

- **No new screen-share prompt** — we reuse the live `DESKTOP.stream`.
- **No new transcription worker** — vision recognition is a normal `postChat`.
- **No change to `runAssistAnswer` / the queue / dedup / history** — a screen
  question is just another string entering `enqueueQuestion()`.
- **No proxy change for the vision call itself** — `messages` (incl. image
  blocks) already passes through `apps-script.gs:102`.

---

## 5. The one backend touch

The proxy may pin/validate the model. Confirm `apps-script.gs` accepts
`claude-haiku-4-5` for the extraction call (it uses `body.model ||
DEFAULT_MODEL` at line 96, so any client-supplied model is already honored —
**likely no change needed**). If a future version adds a model allow-list,
include the classifier/vision model there. No new action verb is required.

---

## 6. Edge cases & decisions

| Case | Handling |
|------|----------|
| User shared a **window without video** (audio-only) | No `videoTrack`; hide the capture button and toast "Re-share a tab or screen (not audio-only) to read questions." |
| **Cross-origin / DRM** content (Netflix, protected video) | `grabFrame` yields black/throws; toast and skip. Normal app/UI windows are fine. |
| **Privacy** — a screenshot leaves the machine | Unlike the audio path (Whisper is fully local), vision *must* send the frame to the API. Call this out in the UI copy and only fire on an explicit click/hotkey — never on a timer by default. |
| **Cost/latency** | One Haiku vision call (~200 tok out) per capture, user-initiated. Region crop (§3c) further cuts tokens. |
| **No question on screen** | `{found:false}` → toast, nothing queued. |
| **Rapid double capture** | `visionBusy` single-flight gate drops the second. |

---

## 7. Recommended build order

1. **Retain the video track** (§3a) + `grabDesktopFrame()` with both paths
   (§3b). Verify a frame is captured.
2. **`recognizeScreenQuestion()` + `SCREEN_VISION_SYSTEM`** (§3d) wired to
   `enqueueQuestion`. End-to-end: screenshot → question → answer in chat.
3. **Button + hotkey + busy state** (§3e) and teardown nulls (§3f).
4. **Region-select crop** (§3c) as a fast follow for accuracy.
5. Privacy copy + audio-only/cross-origin guards (§6).

Steps 1–3 are the minimum viable feature and are mostly plumbing on top of
machinery that already exists. The throughline: **reuse the live screen share
and the existing answer queue — the only new idea is one user-initiated Claude
vision call that turns a frame into a question string.**
