# Improving Randy's Question Understanding

How to make Randy reliably tell a **real, in-scope technical information need**
apart from **unrelated chatter**, and stay accurate when that need is **phrased
as a statement, reworded, garbled by speech-to-text, or asked as a follow-up**.

> **Status (2026-06):** the Tier 1 changes below are now **shipped** in
> `index.html`. The gate detects a technical *information need* — an explicit
> question **or** a statement of a problem/goal/pain involving in-scope tech —
> instead of requiring interrogative form. The classifier returns a split
> verdict (`needs_answer`, `is_question`, `in_scope`, `normalized_question`,
> `confidence`, `topic`, `reason`) with few-shot examples, and Randy answers the
> classifier's `normalized_question` rewrite so statements and garbled/follow-up
> utterances get researched as clean explicit questions. The regex fast path
> stays interrogative-only (precision on a live call); statement-form needs are
> judged by the LLM, with a broadened `looksLikeTechQuestion()` fallback for the
> classifier-down case. Tiers 2–3 remain proposals.

---

## 1. How Randy classifies today

Three tiers, in order of speed (`index.html`):

| Tier | Mechanism | Where | Cost |
|------|-----------|-------|------|
| Fast path | `isInstantTechQuestion()` = `TECH_TOPIC_RE` AND `INSTANT_QUESTION_RE` | 557–569 | ~0 ms |
| Fallback | `looksLikeTechQuestion()`, looser regex, used only when the LLM is down | 559–561 | ~0 ms |
| Accurate | `classifyUtterance()` → Claude Haiku with `CLASSIFIER_SYSTEM` + JSON schema | 521–553, 2272–2287 | ~300–600 ms |

Gating constants (`ASSIST`, 426–447): one confidence threshold `CONF_THRESHOLD: 0.65`,
`CONTEXT_LEN: 3` recent utterances, `HISTORY_PAIRS: 2` prior Q&A pairs.

### What's weak about it

1. **The LLM gate is zero-shot.** `CLASSIFIER_SYSTEM` describes the scope in prose
   but shows **no examples**. Research consistently finds that a handful of
   well-chosen examples — especially *hard negatives* — moves accuracy more than
   any prose tweak. The hardest cases are "in-domain out-of-scope": utterances
   that mention Intune or ConfigMgr but are **not** answerable questions
   ("Can you email me Intune pricing?", "Let's schedule the ConfigMgr migration call").
   The current prompt has nothing to anchor those.

2. **The fast/fallback paths are keyword-brittle.** A reworded question that
   doesn't literally contain a `TECH_TOPIC_RE` keyword — "how do you push apps to
   machines that never touch the domain?" (that's Application Workspace / Intune)
   — fails the fast path entirely and leans 100% on the LLM. Regex doesn't
   understand paraphrase.

3. **One confidence number conflates three decisions.** "Is it a question?",
   "is it in scope?", and "could an SE answer it now?" are collapsed into a single
   `confidence`. That makes the 0.65 threshold a blunt instrument and makes the
   decision log hard to debug.

4. **Garbled speech is handled charitably but never *normalized*.** The prompt
   tells Haiku to read "in tune" as Intune, but the **raw** garbled string is what
   gets passed downstream to the answer model and to dedup. A cleaned, canonical
   version of the question is never produced.

5. **Thin coreference handling.** Follow-ups like "what about the second one?" or
   "and on hybrid-joined boxes?" depend on resolving references to earlier turns.
   Three utterances of raw context is the only support; there's no running
   "current topic" the classifier can lean on.

6. **No measurement.** There's a decisions ring buffer (8 items, for the status UI)
   but no labeled eval set. Today there's no way to say whether a change helped.

---

## 2. What the research says

- **Few-shot beats prose, and hard negatives matter most.** Open-world intent
  benchmarks are hard precisely because of in-scope-looking out-of-scope examples;
  showing the model those examples is the highest-leverage fix.
  ([arXiv 2507.22289](https://arxiv.org/html/2507.22289v1),
  [ACL 2025 OOS detection](https://aclanthology.org/2025.acl-industry.25.pdf))

- **Query rewriting / canonicalization resolves paraphrase and coreference.**
  Having the LLM rewrite the utterance into a clear, context-independent question
  cuts coreference errors to <3% and improves every downstream step.
  ([LLM4CS, arXiv 2303.06573](https://arxiv.org/html/2303.06573),
  [Informative Query Rewriting, arXiv 2310.09716](https://arxiv.org/html/2310.09716))

- **Embedding/semantic routing handles rephrase cheaply and fast.** Pre-encoding
  canonical example utterances and routing by nearest-neighbor is ~50x faster and
  ~100x cheaper than an LLM call, and a tiny model on ~64 examples can beat
  few-shot prompting of a 20B model — robust to wording because it compares
  *meaning*, not keywords.
  ([vLLM Semantic Router](https://blog.vllm.ai/2025/09/11/semantic-router.html),
  [Embeddings intent classifier](https://medium.com/@durgeshrathod.777/intent-classification-in-1ms-how-we-built-a-lightning-fast-classifier-with-embeddings-db76bfb6d964))

- **Cascade by confidence.** Send high-confidence cases down a fast path and only
  escalate the uncertain middle band to a stronger/slower check — high accuracy
  without paying full cost on every utterance.
  ([Real-time intent router](https://moshe-haim-makias.medium.com/building-a-real-time-intent-router-why-you-dont-need-a-large-llm-44ff0eda24b6))

---

## 3. Proposal — three tiers by effort

### Tier 1 — prompt + schema (hours, no new infra, biggest single win)

**1a. Add few-shot examples to `CLASSIFIER_SYSTEM`.** A dozen labeled lines covering:
- clear in-scope questions (RCT, App Workspace, Intune, ConfigMgr, patch, packaging);
- **hard negatives** that mention products but aren't answerable questions
  (pricing, scheduling, contract, "send me the deck", status updates);
- **rephrased** questions with no literal product keyword;
- **STT-garbled** questions ("in tune", "config manager", "liquid" = Liquit).

**1b. Split the verdict in the JSON schema** instead of one `confidence`:

```js
{
  is_question:   boolean,   // interrogative / clear ask?
  in_scope:      boolean,   // Recast / endpoint-adjacent?
  answerable_now: boolean,  // SE could answer without asking back?
  is_garbled:    boolean,   // STT mangled it?
  normalized_question: string, // clean, context-independent rewrite
  topic: string,
  confidence: number,
  reason: string
}
```

Gate on `is_question && in_scope && answerable_now && confidence >= threshold`.
This makes the decision log readable and lets you tune each axis independently.

**1c. Use `normalized_question` downstream.** Feed the *cleaned* question to the
answer model and to dedup — not the raw garbled transcript. This directly serves
"understand reworded/garbled questions": the classifier both judges *and* repairs
the utterance in the same call, so the answer is generated from a clean question.
The rewrite also resolves follow-up references ("the second one" → the actual thing).

> Cost note: the extra fields and rewrite add output tokens to a Haiku call that
> already runs per utterance. Keep `normalized_question` short and capped.

### Tier 2 — semantic topic gate + confidence cascade (days)

**2a. Replace `TECH_TOPIC_RE` with an embedding similarity gate.** Precompute
embeddings for ~40–60 canonical in-scope example questions (one-time, cached).
At runtime, embed the utterance and take max cosine similarity. This survives
rephrasing because it compares meaning, not keywords, and is far cheaper than the
LLM. Use the score as a fast-path signal *and* pass it to the classifier as a hint.

**2b. Two-band cascade** instead of a single 0.65 cutoff:
- score ≥ ~0.8 and clearly a question → act immediately (skip or trust Haiku);
- ~0.5–0.8 → escalate to the Haiku classifier (or a Sonnet check) before acting;
- < ~0.5 → ignore.

This keeps latency low on the easy cases and spends model budget only on the
genuinely ambiguous middle.

### Tier 3 — measurement and (optionally) a trained router (ongoing)

**3a. Build a labeled eval set first.** Pull real utterances from call recordings /
the decisions buffer, label each (in-scope question / out-of-scope / garbled /
follow-up). Without this you can't tell whether 1a–2b actually helped. This is the
prerequisite for everything else, even though it's listed last.

**3b. Track precision and recall**, not just accuracy. On a live call, a **false
positive** (Randy answers off-topic chatter) is worse than a miss — weight
precision accordingly when picking thresholds.

**3c. Optional: train a small embedding classifier** (e.g. SetFit) on the labeled
set for sub-millisecond, keyword-independent routing once you have ~50–100
examples per class. Only worth it if Tier 1–2 leave gaps.

---

## 4. Recommended order

1. **Tier 1a + 1b + 1c** — few-shot hard negatives, split schema, normalized
   question. Highest impact, lowest risk, prompt-only.
2. **Tier 3a** — start logging labeled examples *now* so later changes are
   measurable.
3. **Tier 2a/2b** — semantic gate + cascade once you have examples to validate
   against.
4. **Tier 3c** — only if needed.

The throughline: let the **LLM rewrite each utterance into a clean canonical
question** (handles garble, paraphrase, and follow-ups in one step), judge scope
with **concrete examples** rather than prose, and compare **meaning not keywords**
on the fast path.

---

## Sources

- [Intent Recognition and Out-of-Scope Detection using LLMs (arXiv 2507.22289)](https://arxiv.org/html/2507.22289v1)
- [Efficient Out-of-Scope Detection in Dialogue Systems (ACL 2025)](https://aclanthology.org/2025.acl-industry.25.pdf)
- [Exploring Zero and Few-shot Techniques for Intent Classification (arXiv 2305.07157)](https://arxiv.org/pdf/2305.07157)
- [LLM4CS: LLMs Know Your Contextual Search Intent (arXiv 2303.06573)](https://arxiv.org/html/2303.06573)
- [LLM-Aided Informative Query Rewriting (arXiv 2310.09716)](https://arxiv.org/html/2310.09716)
- [vLLM Semantic Router](https://blog.vllm.ai/2025/09/11/semantic-router.html)
- [Intent Classification in <1ms with Embeddings](https://medium.com/@durgeshrathod.777/intent-classification-in-1ms-how-we-built-a-lightning-fast-classifier-with-embeddings-db76bfb6d964)
- [Building a Real-Time Intent Router](https://moshe-haim-makias.medium.com/building-a-real-time-intent-router-why-you-dont-need-a-large-llm-44ff0eda24b6)
