# AI gateway — one door, capability-routed providers

> Status: **implemented — all five phases shipped (P1 #530, P2 #532, P3 #533, P4 #535, P5 #538).**
> Issue: `ahaqqu/RumaQ#523`. Owner directive: 2026-11-07 ("AI is the core of RumaQ — every
> feature routes through one door").
>
> Reviewed against `origin/main` @ `30ea632`; each phase's "what shipped" block records where the
> code deviated from this design.

## 0. Decision summary

The eleven decisions this document rests on. **Six were taken by the owner on 2026-11-07** (D1, D2, D3,
D8, D9, D10) and are no longer open; the rest need sign-off with the document.

| #   | Decision             | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Data model           | **Owner-decided 2026-11-07.** Two new tables — `ai_providers` (label, wire kind, preset, base URL, sealed key) and `ai_capabilities` (one assignment per capability) — **owned by the household**: `household_id` FK, unique `(household_id, lower(label))`, PK `(household_id, capability)`. Keys are household property; usage rows keep the acting `user_id` **and** the household. `user_settings.ai_*` stays one release as a compatibility projection, then drops. |
| D2  | Provider abstraction | **Owner-decided 2026-11-07.** Four **wire-protocol** adapters — `openai-compatible` (OpenAI, Ollama, OpenCode, custom base URL), `anthropic`, `gemini`, `questions` — behind one interface. The six vendor presets are data rows (label + canonical base URL), never classes; models are capability/provider data, never preset data.                                                                                                                                    |
| D3  | Decision wire        | **Owner-decided 2026-11-07.** The `questions` adapter speaks a typed question/answer contract: `POST {base}` with `{state, model, questions:{<name>:{type,instructions,criteria}}}` → `answers.<name>.{choice, confidence}`. Reason-as-NULL and zero reported tokens are accepted limitations.                                                                                                                                                                           |
| D4  | The door             | `backend/src/lib/ai/` (barrel `index.ts`). Outside `lib/ai/**` no file may import an adapter, hold an API key, or contain a provider hostname — enforced by a test.                                                                                                                                                                                                                                                                                                      |
| D5  | Capability enum      | `decision` \| `reasoning` \| `vision`. Additive; `embedding` is explicitly out of scope.                                                                                                                                                                                                                                                                                                                                                                                 |
| D6  | Migration            | Backfill is **behaviour-preserving**: every configured user's one provider becomes provider #1 and is assigned to all three capabilities with today's model values. **No compatibility window** (owner-decided): the legacy `user_settings.ai_*` columns are left untouched by P1 and **dropped in P3**, in the same PR that replaces the Settings screen.                                                                                                               |
| D7  | Empty start          | **No default provider.** A new household has zero `ai_providers`, zero `ai_capabilities`, no implicit model — and therefore today's exact "not configured" behaviour (402, review assist/auto → manual, no calls) until a household owner adds a provider and assigns capabilities. No preset is preselected.                                                                                                                                                            |
| D8  | No server fallback   | **Owner-decided 2026-11-07.** `RUMAQ_SERVER_AI_*` is retired: no env key, no implicit provider, no platform-funded call. Resolution is the caller's assignment → 402. QA/testing accounts get ordinary rows through Settings; automation seeds the same rows in its setup step (§3.4).                                                                                                                                                                                   |
| D9  | Funding & limits     | **Owner-decided 2026-11-07.** Resolved access and usage rows carry `funding: 'household' \| 'platform'`. v1 is always `'household'` — BYOK is the caller's own bill, so **no AI rate limits** and no per-user cap. A future RumaQ-provided (premium) mode reuses the same dimension; **all** metering and limits live in the facade, and no call site may implement a cap.                                                                                               |
| D10 | Ciphertext binding   | **Owner-decided 2026-11-07.** Each provider key is AES-GCM encrypted with its **row id as additional authenticated data** (`v2:` envelope). P2 ships it with a **transparent re-encrypt-on-read** for legacy `v1:` ciphertext: decrypt without AAD, rewrite bound to the row, never ask the user for the key again. A copied ciphertext cannot be re-planted on another provider row.                                                                                    |
| D11 | Rollout              | **Five** independently mergeable PRs (P1–P5): schema + resolver swap, the door + adapters + AAD, Settings API/UI **with the legacy column drop**, call sites by capability, persona/key test server-side. P6 is gone: with no compatibility window there is nothing left to clean up later.                                                                                                                                                                              |

D2 is the one place this document refines the directive's literal wording. The directive listed five
adapter names ("OpenAI-compatible, Anthropic, Gemini, Ollama, custom base URL"); the owner confirmed
that three of them are one wire protocol with different base URLs. Collapsing them is what makes "one
interface" true instead of decorative, and it is what lets the typed-decision adapter (D3) sit beside
chat adapters without a special case.

Three more of the owner's calls shaped the model rather than the code. **D1** puts providers on the
household because the household is what pays, and the only thing claiming a key is personal was the
schema. **D9** reserves a `funding` dimension so that a later platform-funded mode is a new value on
an existing field, not a second resolution path — and it removes the temptation to rate-limit BYOK
calls, which are the user's own bill. **D10** closes the one place where "one door" was also a
security boundary in name only: a sealed key can no longer be moved between provider rows.

Every question this document raised is now answered: the risks are in §7.1 and the owner's dispositions
of the seven remaining questions are recorded in §7.2.

---

## 1. Current state

### 1.1 What exists today

| Module                            | Lines | Role                                                                                                               |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `backend/src/lib/ai.ts`           | 604   | Protocol dispatcher **and** three feature call shapes (`completeText`, `extractReceiptItems`, `extractExpiryDate`) |
| `backend/src/lib/ai-access.ts`    | 197   | Credential resolution (user → server) and the `ai_usage_events` writer                                             |
| `backend/src/lib/chat.ts`         | 105   | Prompt builder + `completeText` call                                                                               |
| `backend/src/lib/plans.ts`        | 175   | Prompt builder + `completeText` call + its own JSON extraction                                                     |
| `backend/src/lib/review-ai.ts`    | 769   | Review prompt, strict verdict validation, verdict cache, sweep driver, usage batching                              |
| `backend/src/lib/document-ocr.ts` | 166   | Post-model expiry validation + the audit pairing around one vision call                                            |

Provider protocol code is all in `ai.ts`:

- `callOpenAICompatible` — `backend/src/lib/ai.ts:196` (used by OpenAI `:245`, OpenCode `:424`, Ollama `:489`, custom `:506`)
- `callGemini` — `:268`; `callAnthropic` — `:346`
- `callProvider` switch — `:474-522`; hardcoded base URLs at `:167` (`https://ollama.com/v1`), `:251` (`api.openai.com/v1`), `:317` (`generativelanguage.googleapis.com/v1beta`), `:391` (`api.anthropic.com/v1/messages`), `:430` (`api.opencode.ai/v1`)
- Hardcoded per-vendor default models at `:253` (`gpt-4o-mini`), `:315` (`gemini-3.6-flash`), `:358` (`claude-3-haiku-20240307`), `:432` (`opencode-vision`), `:170` (`glm-5.3-flash`)
- Thinking-level maps at `:173` (Gemini token budget), `:180` (Anthropic budget), and `:214` (`reasoning_effort` sent to every OpenAI-compatible endpoint)
- Image encoding: Gemini `inline_data` at `:290-299`, Anthropic `source.base64` at `:369-379`, OpenAI `image_url` data URI at `:549-555`

### 1.2 Every AI call site

| #   | Entry point                                                                             | Reaches the provider via                                                    | Model used today                                       | Usage row written at        |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| 1   | `POST /api/ai/chat` — `api.ts:1677`                                                     | `chat.ts:104` → `completeText`                                              | `ai_model` (`api.ts:1838`)                             | `api.ts:1856`               |
| 2   | `POST /api/plans/generate` — `api.ts:4416`                                              | `plans.ts:158` → `completeText`                                             | `ai_model` (`api.ts:4555`)                             | `api.ts:4573`               |
| 3   | `POST /api/purchases/scan` — `api.ts:1865`                                              | `ai.ts:538` `extractReceiptItems`                                           | **`ai_model`** (`api.ts:1953`)                         | `api.ts:1972`               |
| 4   | `POST /api/documents/:id/files/:fileId/extract-expiry` — `plugins/documents/ocr.ts:155` | `document-ocr.ts:93` → `ai.ts:583`                                          | `ai_vision_model` → `ai_model` (`document-ocr.ts:148`) | `document-ocr.ts:121`       |
| 5   | `POST /api/admin/review/evaluate` — `api.ts:3364`                                       | `review-ai.ts:604` → `:448` `completeText`                                  | `ai_model` + `ai_thinking_level`                       | batched, `review-ai.ts:418` |
| 6   | Cron `*/30 * * * *` — `gateway.ts:185`                                                  | `review-ai.ts:723` → same as #5                                             | same                                                   | batched, `review-ai.ts:418` |
| 7   | `POST /api/ai-key/test` — `api.ts:1298`                                                 | direct `fetch` to 5 provider `/models` endpoints (`api.ts:1353-1413`)       | n/a                                                    | none                        |
| 8   | Persona copy generation — `frontend/src/lib/persona.js:121`                             | **browser** `fetch` to 5 provider endpoints (`:189-239`, dispatcher `:242`) | `ai_model` from React state                            | none                        |
| 9   | Key test — `frontend/src/lib/persona.js:281`                                            | **browser** `fetch` to 5 provider `/models` endpoints                       | n/a                                                    | none                        |
| 10  | `GET /api/ai/usage` — `api.ts:1439`                                                     | resolves access for display only (`api.ts:1486`)                            | n/a                                                    | reads                       |

Call sites 8 and 9 are the ones that violate the directive most literally: the browser talks to
five providers directly, so those calls are unbilled in `ai_usage_events`, unthrottled, and the
key lives in page memory. Call site 3 is an outright inconsistency — a **receipt image** is sent
with the _text_ model while the vault's OCR sends the vision model (`document-ocr.ts:148`).

### 1.3 How settings resolve today

`resolveAiAccess` — `backend/src/lib/ai-access.ts:95-133`:

1. **User branch** (`:99`): requires **both** `ai_provider` and a non-empty `encrypted_ai_key`,
   else skipped silently. Decrypts with `WORKER_ENCRYPTION_KEY` (`crypto.ts:100`).
   `visionModel = ai_vision_model ?? ai_model` (`:108`); `thinkingLevel` normalised against
   `low|medium|high` (`:80-82`); missing model = "provider default applies".
2. **Server branch** (`:114-130`): `RUMAQ_SERVER_AI_PROVIDER` + `RUMAQ_SERVER_AI_KEY`, and the
   provider must be in `SERVER_PROVIDER_PRESETS` (`:70-76`, which excludes `custom`). One model
   (`RUMAQ_SERVER_AI_MODEL`) serves **both** text and vision (`:126`); no thinking level.
3. Otherwise `null` → every route maps that to **402** "AI provider not configured".

Step 2 is **retired by D8**: after P1 there is no server branch at all, so an unconfigured account is
unconfigured rather than platform-funded (§3.4).

Everything above is **per user**. `user_settings` is keyed by `user_id`, but the thing that pays is
the household — so P1 moves provider ownership to `households` (§3.1). `ACTIVE_HOUSEHOLD_SQL`
(`auth.ts:136-145`) is the one definition of "the household this request acts in"; the backfill
mirrors it, so migration and runtime can never disagree about whose household a key belongs to.

There is exactly one access per request, resolved once and passed down. The review sweep resolves
**once per run** (`review-ai.ts:322-338`), deliberately — one settings read for up to 20 items,
because each D1 read is a subrequest against the free plan's 50-per-invocation cap
(`review-ai.ts:60-66`).

`USER_AI_SETTINGS_COLUMNS` (`ai-access.ts:22-29`) is the single projection constant that every
hand-written `SELECT … FROM user_settings` interpolates (`api.ts:1068`, `:1257`, `:1724`, `:4433`);
`loadUserAiSettings` (`:39-47`) is the single loader. This is the seam the new model must keep —
it is the reason the AI settings columns have one owner today.

### 1.4 Where provider coupling lives (the inventory the refactor must clear)

1. **Protocol switch**: `ai.ts:474-522`, plus the six base URLs and five default models above.
2. **Key in every signature**: `completeText(provider, apiKey, …)` (`ai.ts:524-536`),
   `extractReceiptItems(…, provider, apiKey, …)` (`:538-544`), `sendChatMessage(provider, apiKey, …)`
   (`chat.ts:96-106`), `generateAiPlan(provider, apiKey, …)` (`plans.ts:133-140`), and the four
   route-level `resolveAiAccess` + `access.apiKey` handoffs (`api.ts:1818`, `:1946`, `:4545`,
   `document-ocr.ts:141`). `AiAccess` carries the plaintext key (`ai-access.ts:49-66`) into six
   modules by design.
3. **Per-provider request quirks scattered across call shapes**: Gemini's system-prompt-as-text-part
   (`ai.ts:278-282`), Anthropic's top-level `system` (`:384-386`), OpenAI's
   `max_completion_tokens` (`:260-263`), Ollama's "omit max_tokens" (`:489-497`).
4. **Three copies of JSON extraction**: `parseJsonResponse` (`ai.ts:447`), an inline copy in
   `plans.ts:160`, and `parseReviewVerdict` (`review-ai.ts:234`, which correctly reuses
   `parseJsonResponse` at `:237`).
5. **Provider picklist duplicated**: `schemas.ts:26-28` (settings), `schemas.ts:54` (key test),
   `Settings.jsx:352-364` (dropdown), `frontend/src/lib/aiProviders.js:4-11` (defaults, with a
   "keep in sync" comment), `ai-access.ts:70-76` (server allowlist), `ai.ts:480-521` (switch).
   Adding a provider today is a six-file edit.
6. **Transport policy in routes**: timeouts exist only where a caller remembered to pass a signal
   (`review-ai.ts:467` `AbortSignal.timeout(20_000)`); chat, scan, plans have **no deadline**.
7. **UI coupling**: `Settings.jsx:351-437` hardcodes the vendor select and one model field per
   provider; there is no way to express "two providers at once".

### 1.5 Storage today

- `user_settings.ai_provider` + `encrypted_ai_key` — `migrations/0001_schema.sql:147-148`
- `user_settings.ai_base_url` + `ai_model` — `migrations/0008_user_settings_ai_custom.sql`
- `user_settings.ai_thinking_level` — `migrations/0009_user_settings_ai_thinking.sql`
- `user_settings.ai_vision_model` — `migrations/0033_user_settings_ai_vision_model.sql` (nullable
  add, no backfill: NULL = fall back to `ai_model`)
- `ai_usage_events(id, user_id, ts, date, provider, model, input_tokens, output_tokens, cached_tokens, key_source)`
  — `migrations/0015_ai_usage_events.sql:14-33`; `provider` is the kind string, `model` NULL means
  "provider default"; one-year retention via `deleteExpiredAiUsageEvents` (`ai-access.ts:191`).

**Usage knows a person but not the thing that pays.** There is no `household_id` and no funding
column, so today's data cannot answer "what did this household spend" — the question any
RumaQ-funded mode is built on.

All of it is **one provider per user**, which is the root cause: the schema has no place to put a
second provider, and no place to say "this capability uses that one".

### 1.6 What is worth keeping (do not regress these)

- One call → one usage row, recorded on failure too (the provider billed the input tokens) —
  `document-ocr.ts:121-136`, `review-ai.ts:418-431`.
- Usage rows batched into **one** `db.batch` per sweep — `review-ai.ts:650-662`.
- Prompt/answer separation: prompts are feature policy, the dispatcher is transport policy.
- The strict post-model validation gates (`normalizeExpirySuggestion` `document-ocr.ts:54`,
  `parseReviewVerdict` `review-ai.ts:234`) — a malformed answer is a typed failure, never a guess.
- Never log document content or key material — `document-ocr.ts:78-84` precedent.
- 402 for "not configured", 502 for "provider failed" — pinned by route tests.

---

### 1.7 What hurts today, structurally

Four problems share one cause — no single owner of "how AI is paid for and by whom":

- **Ownership mismatch.** A key belongs to a `user_id` in the schema and to a household in reality.
  Partners cannot share a key without copying it, and a member leaving a household takes the
  household's AI configuration with them (the rows cascade with the user).
- **Nothing can be metered.** Five server call sites each resolve their own credentials, and two
  browser paths call providers directly. A RumaQ-funded mode built on that surface would need five
  implementations plus two that cannot be enforced client-side.
- **Rate limits have nothing to attach to.** Limiting a BYOK call protects nobody's bill but the
  caller's, which is why the app does not do it — the only sound reason to add a cap is platform
  funding (D9).
- **Cost cannot be attributed to a household.** Usage rows carry `user_id` and no household, so
  "which household spent this" is a join, not a record.

## 2. Target architecture

**Why one door is load-bearing, not stylistic.** Three requirements only exist if every call goes
through one module: **(a)** platform-funded AI can only be metered, attributed and limited if there
is exactly one place that dispatches a provider request; **(b)** a capability assignment is only
meaningful if nothing can bypass it — a single `fetch` outside the door silently ignores the
assignment; **(c)** "what did this household spend" needs one writer for `ai_usage_events` and one
place that knows the funding source. Today none of the three holds (§1.7), which is why the boundary
test in §2.3 is a security control and not a style rule.

### 2.1 Module layout

```
backend/src/lib/ai/
  index.ts            ← THE DOOR. The only AI import allowed outside lib/ai/**.
  types.ts            ← Capability, AiMessage, AiCall, AiResult, ThinkingLevel, TokenUsage
  errors.ts           ← AiError + code→HTTP mapping
  capabilities.ts     ← resolveAccess(ctx, capability): household-scoped, the whole precedence ladder
  credentials.ts      ← household provider rows → decrypt (AAD-bound, D10, lazy re-encrypt); NO other module may import this
  key-material.ts     ← the decrypted key/endpoint/thinking level beside an opaque handle (WeakMap); NO other module may import this
  presets.ts          ← the vendor catalog as DATA (label, kind, canonical base URL)
  usage.ts            ← buildAiUsageEventStatement / recordAiUsageEvent / retention (moved)
  decision.ts         ← the {choice, confidence} parse shared by chat-shaped decision calls
  adapters/
    types.ts          ← AiAdapter interface
    openai.ts         ← chat-completions wire (OpenAI, OpenCode, Ollama, custom base URL)
    anthropic.ts      ← Messages API wire
    gemini.ts         ← generateContent wire
    questions.ts      ← typed question/answer wire (one decision question in, one choice out)
    registry.ts       ← kind → adapter; the ONLY switch on kind
    wire.ts           ← shared transport helpers: failure mapping, Retry-After, media encoding
    chat-decide.ts    ← prompt + strict JSON for a chat-shaped decide()
```

Two more modules landed beside the sketch in P2: `parse.ts` (the fence-tolerant JSON reader every
structured answer goes through) and `signal.ts` (`AbortSignal.timeout` + `AbortSignal.any`
composition for the per-call deadline). A P2-only `legacy.ts` holds the deprecated bridge's
resolution and the six legacy vendor ids; it dies with the shims in P4 (see below).

`backend/src/lib/ai.ts` becomes a **deprecated shim** in P2 (same exports, delegating to the door) so
the adapters land without touching a single feature, and it is **deleted** in P4 when the call sites
move (imports become `lib/ai/index.js`, explicit `index.js` per the `ports/storage/index.js`
precedent). The old `ai-access.ts` dissolves in P2–P4: `P2` moves its resolution into `lib/ai/legacy.ts`
(inside the door, because that resolution reads key material) and leaves the file a thin deprecated
shape; `P3`/`P4` delete it with the shim. Resolution → `capabilities.ts`, usage →
`usage.ts`, the projection constant stays with the settings read model until P3 drops it with the column.

### 2.2 The public API

Everything a feature needs, and nothing else. No `apiKey` ever appears in a signature.

```ts
// backend/src/lib/ai/index.ts

export type Capability = 'decision' | 'reasoning' | 'vision'
export type ThinkingLevel = 'low' | 'medium' | 'high'

/**
 * Who pays for this call. Reserved by D9: v1 has exactly one value, so every
 * branch below is a no-op today and a single line the day RumaQ funds a call.
 * 'household' = the caller's own provider row; 'platform' = a future
 * RumaQ-provided (premium) provider, metered by subscription.
 */
export type Funding = 'household' | 'platform'

/** What a provider call costs / is attributed to. Carried on success AND failure. */
export type AiCall = {
  capability: Capability
  householdId: string // the household that owns the provider (D1)
  providerKind: ProviderKind // 'openai-compatible' | 'anthropic' | 'gemini' | 'questions'
  providerId: string // always a household-owned row; there is no server fallback (D8)
  model: string | null // null = the adapter's default for this capability
  funding: Funding // v1 always 'household' (D9)
}

/**
 * An opaque, pre-resolved capability access. Resolve ONCE per request/run and
 * reuse it for N calls (the review sweep's subrequest budget depends on this).
 * The decrypted key is held in module-private state inside the door; the
 * handle exposes no accessor for it.
 */
export type AiAccessHandle = {
  readonly capability: Capability
  readonly call: AiCall
}

/**
 * `householdId` is the RESOLVED household the request acts in — the same value
 * `propsAuthMiddleware` sets via ACTIVE_HOUSEHOLD_SQL (auth.ts:136-145), never
 * re-derived here. `userId` is the acting member: it is not used to resolve
 * anything, only to attribute the usage row.
 */
export type AiCtx = { env: Env['Bindings']; userId: string; householdId: string }

export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | AiContentPart[] }
  | { role: 'assistant'; content: string }

export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; bytes: ArrayBuffer; mimeType: string }

export type AiResult = {
  text: string
  call: AiCall
  usage: TokenUsage // provider-reported; zeroes when it reported none
}

/** Resolve once. null = this capability is not configured for the household (402). */
export function resolveAccess(ctx: AiCtx, capability: Capability): Promise<AiAccessHandle | null>

/**
 * Prose in, prose out. The REASONING capability only — there is no way to ask
 * for a decision answer here, which is what keeps the capability unambiguous.
 */
export function completeText(
  args: AiCtx & {
    access?: AiAccessHandle // omit to resolve internally (single-call routes)
    messages: AiMessage[]
    json?: boolean // ask the adapter for its JSON mode when it has one
    thinkingLevel?: ThinkingLevel | null
    maxTokens?: number
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<AiResult>

/** Image-in, text-out. Receipt scan and vault expiry OCR. */
export function vision(
  args: AiCtx & {
    access?: AiAccessHandle
    parts: AiContentPart[]
    json?: boolean
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<AiResult>

/** One typed decision: a stated question, a closed choice list, a confidence. */
export type DecisionAsk = {
  state: string // the subject being classified/decided
  question: string // one imperative sentence
  criteria?: string // labelled rubric, newline-separated
  choices: readonly string[] // closed vocabulary; the answer must be one of these
}

export type DecisionResult = {
  choice: string
  confidence: number | null // null when the provider reports none
  reason: string | null // null on providers that answer choice+confidence only
  call: AiCall
  usage: TokenUsage
}

export function decide(
  args: AiCtx & {
    access?: AiAccessHandle
    ask: DecisionAsk
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<DecisionResult>

/**
 * The OTHER decision shape: a schema-constrained JSON DOCUMENT (quick-add:
 * items + qty + unit + store), not one choice. Same capability, different wire
 * requirement — only chat-shaped providers can serve it (see §2.4). No shipped
 * feature uses this yet; it lands with quick-add and is specified now so the
 * capability enum never needs a second meaning.
 */
export function structured<T>(
  args: AiCtx & {
    access?: AiAccessHandle
    messages: AiMessage[]
    validate: (raw: unknown) => T // feature policy: the feature owns its schema
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<{ value: T; call: AiCall; usage: TokenUsage }>

/**
 * Usage accounting, beside the door so call sites never hand-build SQL.
 * The row records the ACTING user (`userId`) plus `call.householdId` and
 * `call.funding`, so a member's call is attributable without exposing the key.
 */
export function buildUsageEventStatement(
  env: Env['Bindings'],
  args: { userId: string; call: AiCall; usage: TokenUsage },
  now?: Date
): ReturnType<D1Database['prepare']>

export function recordUsage(
  env: Env['Bindings'],
  args: { userId: string; call: AiCall; usage: TokenUsage },
  now?: Date
): Promise<void>

export { AiError, isAiError } from './errors.js'
```

> **P2 implementation notes.** The usage exports keep their shipped names in code
> (`buildAiUsageEventStatement` / `recordAiUsageEvent`, re-exported by `index.ts`) so no P1 call site
> changes in P2. `AiError.call` is `AiCall | null` — null exactly for `not_configured`, where no
> provider row was resolved, so there is no call to name and no bill; every other code carries the
> attempted call and whatever usage the provider reported before failing.

**Failure carries the bill.** `AiError` exposes `{ code, httpStatus, call, usage, retryable }`, so
`document-ocr.ts`'s "record the failed attempt's tokens" rule survives without the call site holding
a key: catch, read `err.usage` and `err.call`, write the row, rethrow.

**Resolution is separate from calling** so the sweep can keep its one-read-per-run shape:
`resolveAccess` → one D1 read; `completeText({ access })` → one fetch, zero extra reads.

### 2.3 The rule for call sites

> Outside `backend/src/lib/ai/**`, a module may (a) build prompts, (b) validate the model's answer,
> (c) write usage rows through `buildUsageEventStatement`, and (d) map `AiError` to HTTP. It may
> **not** import an adapter, hold an API key, contain a provider hostname, or `fetch` a model
> endpoint.

Enforced by a test, following `backend/src/__tests__/plugin-boundary.test.ts`:

- `ai-boundary.test.ts` walks `backend/src/**` (excluding `lib/ai/**`) and fails on
  `from '.*ai/adapters`, `api.anthropic.com|generativelanguage.googleapis.com|api.openai.com|ollama.com|api.opencode.ai|api.typesafe.ai`, on `\.apiKey\b`, and on any import of the two key-material
  modules (`credentials.ts`, `key-material.ts`). Relative specifiers are resolved in every form the
  bundler accepts (`.js`, extensionless, directory index), the door may not re-export key material,
  and the facade's VALUE export surface is pinned to an exact list — so neither an extensionless
  `import` nor `export { accessMaterial } from './key-material.js'` can walk out. It also pins the
  deprecated `lib/ai/legacy.ts` importers (`lib/ai.ts` + `lib/ai-access.ts`) and asserts that exact
  set, so a new consumer of the dying bridge fails here first.
- **P2's two pinned exemptions**, asserted by the test so they can only shrink: the hostname rule
  exempts `apps/api.ts` — the legacy `POST /api/ai-key/test` probe, deleted in P3 — and the `.apiKey`
  rule exempts `lib/ai-access.ts` plus the three modules that forward its key to the shim
  (`apps/api.ts`, `lib/document-ocr.ts`, `lib/review-ai.ts`), deleted in P4. Without them the test
  cannot be green while P2 is forbidden to touch a feature file; P3 and P4 must empty them — the test
  asserts each listed file is still a real violation, so a stale exemption cannot outlive its code.
- `frontend-ai-boundary.test.js` walks `frontend/src/**` and fails on the same hostnames (after P5
  there are zero legitimate hits; today it would fail at `persona.js:189-330`).

The frontend keeps the boundary too: it may call `/api/ai/*` and nothing else.

### 2.4 Adapter interface

```ts
// backend/src/lib/ai/adapters/types.ts
// Owner-decided kind set (D2). The vendor a row came from is `preset`, not a fifth kind.
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'questions'

export interface AiAdapter {
  readonly kind: ProviderKind
  /** Static capability matrix (§2.4) — validated at save time, not call time. */
  supports(capability: Capability): boolean
  /** Chat-shaped call: one request, one text answer, one usage report. */
  complete(req: AdapterRequest): Promise<AdapterResult>
  /** Closed-choice decision. Chat adapters do prompt + strict JSON parse. */
  decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult>
  /** Schema-constrained JSON decision. Absent on providers that only answer choices. */
  structured?(req: AdapterRequest): Promise<AdapterResult>
}

export type AdapterRequest = {
  capability: Capability
  /** Always resolved by the door: `capability.model ?? provider.default_model`. */
  model: string
  messages: AiMessage[]
  json: boolean
  thinkingLevel: ThinkingLevel | null
  maxTokens?: number
  baseUrl: string | null
  apiKey: string
  signal: AbortSignal
}
```

**No `defaultModel()` on the interface.** The sketch this section carried one ("today's hardcoded
defaults"); P2 removes it, because `ai_capabilities.model ?? ai_providers.default_model` is
owner-typed data and the resolver already refuses a row where both are blank (§5.1, P1 review
A2/B1). A model is always supplied to an adapter, so no vendor alias ages in code. The six legacy
vendor ids and their old cap sizes survive only in the P2-only `lib/ai/legacy.ts`, which P4 deletes
with the shim.

Capability support must be **data, checked twice** — at save time (`supports(capability)`, plus the
shape check where a capability has two) and at call time (`AiError('unsupported')` as a belt):

| kind                | reasoning (`completeText`) | vision (`vision`)                     | decision · choice (`decide`) | decision · JSON (`structured`) |
| ------------------- | -------------------------- | ------------------------------------- | ---------------------------- | ------------------------------ |
| `openai-compatible` | ✅                         | ✅ (image support is the model's job) | ✅ prompt + strict parse     | ✅                             |
| `anthropic`         | ✅                         | ✅                                    | ✅ prompt + strict parse     | ✅                             |
| `gemini`            | ✅                         | ✅                                    | ✅ prompt + strict parse     | ✅                             |
| `questions`         | ❌                         | ❌                                    | ✅ native (D3)               | ❌                             |

`supports()` for a chat kind is a static `true`; whether a _model_ reads images is not something we
pretend to know (today's behaviour: send it, let the provider 400). `gemini` is its own kind rather
than an `openai-compatible` base URL because its request/response shape (`contents`/`parts`,
`usageMetadata`, thinking budgets) is genuinely different.

The two decision shapes are deliberate: a closed-choice answer (`same`/`different`, a category slug)
is what a typed decision endpoint is built for, while quick-add must return a JSON document. Assigning
a `questions` provider to the decision capability is allowed, and `structured()` then answers
`unsupported` until the user points decision at a chat provider. That is a visible, typed failure, not
a silent degradation, and it is why `structured()` is not used by any shipped feature yet.

**Both kinds are assignable to `decision`** (owner-decided, §7.2): a chat provider answers the verdict
through its JSON mode, a typed provider answers it natively. The matrix is about which _shape_ a kind
can serve, not about which kind a household must choose.

### 2.5 What deliberately stays outside the door

- **Prompts** (`buildScanPrompt` `ai.ts:28`, `buildExpiryExtractionPrompt` `:57`,
  `buildChatSystemPrompt` `chat.ts:36`, `buildPlanPrompt` `plans.ts:62`,
  `buildReviewSystemPrompt` `review-ai.ts:166`). They are product policy, owner-reviewed and
  load-bearing; the door takes messages, not prompts.
- **Answer validation** (`normalizeExpirySuggestion`, `parseReviewVerdict`). Feature semantics stay
  with the feature; the door only guarantees well-formed transport, and `decide()` additionally
  guarantees "the choice is in the list, the confidence is a number in [0,1]".
- **Usage placement** (which call writes which row, and batching): the door returns the record, the
  feature writes it — that is what keeps the sweep at one batch (P1 must not add a read or a write).

### 2.6 Funding, metering and limits — the reserved shape (D9)

D9 exists so that a future **RumaQ-provided (premium) AI** mode has one home instead of five. v1 ships
the shape, not the mode:

- **`funding` is data, not a branch.** It rides on `AiCall` and on every usage row: `'household'` for
  every call the product can make today. There is no `if (premium)` anywhere in a feature.
- **v1 has no caps, deliberately.** A BYOK call is the household's own bill; rate-limiting it protects
  nobody. So there is no limiter, no per-user quota, and no daily counter for AI (the old `ai_usage`
  daily cap died with #353).
- **The future check has exactly one location**: inside `completeText` / `vision` / `decide` /
  `structured`, before the provider fetch — read the household's entitlement, throw
  `AiError('quota_exceeded', 402)` when the meter says no, otherwise proceed and let the usage row be
  the meter. Nothing outside `lib/ai/**` may count, cap, retry-budget or token-check an AI call;
  adding one at a call site is precisely how a metered mode starts leaking. The P4 boundary test
  already fails any out-of-door import, which is what makes this rule enforceable rather than aspirational.
- **No platform provider exists in v1** (D8 stands): no env key, no seeded row, no fallback. Switching
  `funding` to `'platform'` later is a new provider resolution plus a subscription lookup — not a new
  call path, and not a second resolution ladder in the features.

---

## 3. Data model

### 3.1 Decision: new tables, owned by the household (D1)

Two tables, because they are two different nouns: a **provider** (credentials + wire + endpoint) and a
**capability assignment** (which provider, which model, which thinking level, for what). The unique key
on `ai_capabilities` is then literally the directive: one row per capability.

The owner's D1 adds the scope — **the household owns both tables, not the user**:

- **The household is what pays.** One bill, one subscription, one card, therefore one key set.
  Per-user providers meant a partner's key could not be shared without copying it, and a departing
  member's key left with them — the household's AI configuration _was_ one person's settings.
- **Use stays personal.** The provider is household property; the _call_ is still the member's. Every
  usage row records the acting `user_id` **and** the household, so "Alice spent 40k tokens of the
  family's key" is a row, not a guess (§3.5).
- **Management is owner-only.** The role vocabulary is `owner|member` (`0001_schema.sql:25-31`,
  `lib/households.ts:134-142`): an owner adds/edits/deletes providers and assignments (`requireOwner`,
  403 for members); members read the configuration and use it, but cannot change which key the
  household spends. That is the same gate the roster and invite surfaces use, so there is one
  permission model, not two.
- **Keys stay write-only.** No endpoint returns `encrypted_key` or a decrypted key, for any role;
  `has_key` is the only signal, in either direction. A member never sees the key — they only benefit
  from it.

Rejected alternatives, briefly:

- **Keep providers per-user and add a share table.** Two scopes (owned + shared) means every read
  checks both, capability assignments need a scope column, and the migration has to invent grant rows
  for every existing household. The household is already the billing and permission unit; making it the
  owner is smaller than modelling sharing.
- **Extend `user_settings` with `ai_decision_model` only.** Cheapest migration, but cannot express
  "decision → Jev, reasoning → Claude": one `ai_provider` column means one key, one base URL, one
  vendor. It also makes the owner's core ask ("multiple providers at once") unrepresentable.
- **A JSON blob column (`ai_config`).** No uniqueness, no FK, no per-row delete semantics, and every
  read becomes an app-side parse. Also unqueryable for the admin usage views.
- **`ai_providers` only, with capability assignments inside the provider row.** Then "reasoning and
  vision on one provider, decision on another" works, but the capability becomes a column triple in
  one table (`decision_model`, `vision_model`…) and the unique-per-capability invariant has no home.

### 3.2 DDL sketch — `backend/migrations/0039_ai_gateway.sql`

```sql
-- AI gateway (ahaqqu/RumaQ#523): multiple providers per HOUSEHOLD, one assignment
-- per capability (decision / reasoning / vision), plus capability, household and
-- funding stamps on usage rows.
-- NUMBERING: 0038 is applied (review_ai); this takes the next free slot. Never
-- rename an applied migration — wrangler keys d1_migrations by filename.

-- A provider instance: the wire kind, a preset, an optional base URL, one sealed key.
-- A typed-decision endpoint is a row like any other — a label, kind 'questions',
-- and a base URL. No vendor name appears in a table, column, or type: the
-- abstraction is the wire, and nothing is seeded.
CREATE TABLE IF NOT EXISTS ai_providers (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note (on rowid tables a
  -- TEXT PRIMARY KEY does not imply NOT NULL). The 0039 backfill writes
  -- 'legacy-' || user_id so the migration can address the row deterministically.
  id TEXT PRIMARY KEY NOT NULL,
  -- D1: the HOUSEHOLD owns the credentials, because the household pays. Which
  -- member made a call is recorded per call (ai_usage_events.user_id), never here.
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- The household's name for it ("Work account", "Personal key").
  label TEXT NOT NULL,
  -- The WIRE protocol, not the vendor: 'openai-compatible' serves OpenAI, OpenCode,
  -- Ollama and any custom base URL — see presets.ts. 'gemini' is separate because
  -- its wire is genuinely different; 'questions' is a typed choice/answer wire.
  kind TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic', 'gemini', 'questions')),
  -- The vendor preset this row was created from ('openai', 'opencode', 'ollama',
  -- 'custom', 'anthropic', 'gemini', or NULL for a hand-configured
  -- endpoint). DATA, not a type: a new vendor is a row in presets.ts, never a
  -- migration and never a new kind. The preset supplies the display label, the
  -- canonical base URL. Models are capability/provider data, never preset data.
  preset TEXT,
  -- Optional: NULL = the preset's canonical endpoint. Required when there is
  -- neither a preset endpoint nor this value ('custom', 'questions').
  base_url TEXT,
  -- The provider-level default model ("one alias per key", owner decision
  -- 2026-11-07). A capability that leaves ai_capabilities.model NULL inherits
  -- THIS value; if this is NULL too, the capability is not configured (402).
  -- The value is always owner-typed, so floating vendor aliases
  -- ('chatgpt-4o-latest', 'claude-3-5-sonnet-latest', ':latest' tags) live in
  -- data and nothing in the repo ages.
  default_model TEXT,
  -- AES-GCM ciphertext (lib/crypto.ts). NULL means the row cannot serve a call:
  -- it may be edited and re-keyed, but it cannot be ASSIGNED to a capability
  -- until it has a key. NEVER returned by an API, for any role.
  encrypted_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- If a key is stored it must be a crypto.ts envelope, not a plaintext slip.
  -- BOTH versions are accepted from day one ON PURPOSE: SQLite cannot alter a CHECK
  -- without rebuilding the table, and D10's AAD-bound 'v2:' envelope arrives in P2 —
  -- one release after this migration. v1: = legacy (no AAD), v2: = bound to this row's id.
  CHECK (encrypted_key IS NULL OR encrypted_key LIKE 'v1:%' OR encrypted_key LIKE 'v2:%')
);

-- Case-insensitive label uniqueness WITHIN a household: two "Gemini" rows are a
-- UX bug, not a feature. Expression index, so the check is the database's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_household_label
  ON ai_providers (household_id, lower(label));

-- Exactly one assignment per (household, capability) — the PK IS the invariant.
CREATE TABLE IF NOT EXISTS ai_capabilities (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('decision', 'reasoning', 'vision')),
  -- Deleting a provider clears the assignments that pointed at it (CASCADE):
  -- the capability then becomes not configured (402). The API reports the
  -- cleared capabilities so the UI can warn BEFORE the delete.
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  -- NULL = inherit the provider's default_model. If the provider has none
  -- either, the capability is NOT configured (402) — never an adapter default.
  model TEXT,
  -- Per-capability thinking level: NULL = the provider default.
  thinking_level TEXT CHECK (thinking_level IN ('low', 'medium', 'high')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, capability),
  -- Vision and typed-decision providers take no reasoning knob: a vision OCR read
  -- wants a cheap deterministic answer, and a questions endpoint has no such field.
  -- Enforced here so no adapter has to silently drop it.
  CHECK (capability <> 'vision' OR thinking_level IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_ai_capabilities_provider ON ai_capabilities (provider_id);

-- Usage rows gain the three dimensions D1 and D9 need. All NULL on pre-0039
-- history (still valid; the admin views treat NULL as "unknown").
ALTER TABLE ai_usage_events ADD COLUMN capability TEXT;
-- The household the call acted for. SET NULL, not CASCADE: deleting a household
-- must not delete the record that its tokens were spent.
ALTER TABLE ai_usage_events ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE SET NULL;
-- D9's reserved dimension: 'household' (BYOK) today, 'platform' if RumaQ ever pays.
ALTER TABLE ai_usage_events ADD COLUMN funding TEXT CHECK (funding IN ('household', 'platform'));

-- Per-user "today" (the existing route) and per-household accounting (D1).
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_date_capability
  ON ai_usage_events (user_id, date, capability);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_household_date
  ON ai_usage_events (household_id, date);
```

Deliberately **not** modelled: a `default_provider` flag (the capability assignments say what is
used), an `is_active` flag (delete is the off switch), a member-level permission table (the household
role says who manages, §3.1), a vendor default-model catalog (`default_model` is owner-typed data on a
row, not a preset table), and any secret material outside `encrypted_key` (the existing `crypto.ts`
helpers handle it, and the v1: envelope keeps rotation possible).

Both SQL blocks in this section and §3.3 were executed against `node:sqlite` (the engine class
`migrations.test.ts` already uses) on a 0015/0033/0020-shaped schema before this document was
published: the backfill row set (including a two-member household and a two-household user), the
`ON DELETE CASCADE`/`SET NULL` behaviour, and the kind / label / vision-thinking / funding CHECKs all
behave as described here. P1 turns that ad-hoc check into the committed migration test.

### 3.3 Migration from today's single provider

The one ambiguity the migration must resolve is _whose household a legacy row belongs to_. The answer
is already in the code: `ACTIVE_HOUSEHOLD_SQL` (`auth.ts:136-145`) resolves the household a request
acts in — `user_settings.active_household_id` while it is still a membership, else the oldest
membership. The backfill mirrors that rule exactly, so the migration cannot disagree with the runtime:

```sql
-- 0) The household a legacy row belongs to = the household the request would have
--    acted in (ACTIVE_HOUSEHOLD_SQL, auth.ts:136-145). Repeated in each statement
--    below rather than stored in a temp table: a D1 migration file must not depend
--    on session-local objects surviving between statements.
WITH source AS (
  SELECT s.user_id, s.ai_provider, s.ai_base_url, s.ai_model,
         s.ai_vision_model, s.ai_thinking_level, s.encrypted_ai_key,
         COALESCE(
           (SELECT m.household_id
              FROM household_members m
              JOIN user_settings a ON a.user_id = m.user_id
                                   AND a.active_household_id = m.household_id
             WHERE m.user_id = s.user_id
             LIMIT 1),
           (SELECT m.household_id
              FROM household_members m
             WHERE m.user_id = s.user_id
             ORDER BY m.joined_at, m.household_id
             LIMIT 1)
         ) AS household_id
    FROM user_settings s
   WHERE s.ai_provider IS NOT NULL
     AND s.encrypted_ai_key IS NOT NULL AND s.encrypted_ai_key <> ''
     AND s.encrypted_ai_key LIKE 'v1:%'
),
-- 1) One provider per configured user, handed to that user's household. Members of
--    the same household keep ONE row each; the label disambiguates them with the
--    member's name and a partition-unique sequence, so the (household, lower(label))
--    index can never abort the deploy.
labelled AS (
  SELECT src.*, u.name AS user_name,
         CASE src.ai_provider
           WHEN 'openai' THEN 'OpenAI' WHEN 'opencode' THEN 'OpenCode'
           WHEN 'anthropic' THEN 'Anthropic' WHEN 'gemini' THEN 'Gemini'
           WHEN 'ollama' THEN 'Ollama Cloud' ELSE 'Custom provider'
         END || ' (imported)' AS base_label,
         ROW_NUMBER() OVER (
           PARTITION BY src.household_id, src.ai_provider
           ORDER BY src.user_id
         ) AS rn
    FROM source src
    JOIN users u ON u.id = src.user_id
   WHERE src.household_id IS NOT NULL
)
INSERT INTO ai_providers (id, household_id, label, kind, preset, base_url, encrypted_key)
SELECT 'legacy-' || user_id,
       household_id,
       base_label || CASE WHEN rn > 1
                          THEN ' · ' || COALESCE(NULLIF(user_name, ''), user_id) || ' #' || rn
                          ELSE '' END,
       CASE ai_provider WHEN 'anthropic' THEN 'anthropic'
                        WHEN 'gemini' THEN 'gemini'
                        ELSE 'openai-compatible' END,
       ai_provider,          -- the legacy value IS a preset id (0008 vocabulary)
       ai_base_url,
       encrypted_ai_key
  FROM labelled;

-- 2) Capabilities are household-level, so exactly one member's legacy values win per
--    capability: the household OWNER's, else the earliest-joined member's, else the
--    lowest user id. Deterministic, and every other member's provider row still
--    exists for the owner to assign later — no key is discarded.
WITH source AS ( /* same CTE as above */ ),
candidate AS (
  SELECT src.household_id, src.user_id, m.role, m.joined_at,
         'reasoning' AS capability, src.ai_model AS model,
         src.ai_thinking_level AS thinking_level
    FROM source src
    JOIN household_members m ON m.user_id = src.user_id AND m.household_id = src.household_id
  UNION ALL
  SELECT src.household_id, src.user_id, m.role, m.joined_at,
         'vision', COALESCE(src.ai_vision_model, src.ai_model), NULL
    FROM source src
    JOIN household_members m ON m.user_id = src.user_id AND m.household_id = src.household_id
  UNION ALL
  SELECT src.household_id, src.user_id, m.role, m.joined_at,
         'decision', src.ai_model, src.ai_thinking_level
    FROM source src
    JOIN household_members m ON m.user_id = src.user_id AND m.household_id = src.household_id
),
ranked AS (
  SELECT candidate.*,
         ROW_NUMBER() OVER (
           PARTITION BY household_id, capability
           ORDER BY (role = 'owner') DESC, joined_at, user_id
         ) AS rn
    FROM candidate
)
INSERT INTO ai_capabilities (household_id, capability, provider_id, model, thinking_level)
SELECT household_id, capability, 'legacy-' || user_id, model, thinking_level
  FROM ranked
 WHERE rn = 1;

-- 3) History gains the household and the funding source it actually used: the old
--    per-user key is a household call, the retired shared key was platform-funded.
UPDATE ai_usage_events
   SET household_id = (
     SELECT COALESCE(
       (SELECT m.household_id
          FROM household_members m
          JOIN user_settings a ON a.user_id = m.user_id
                               AND a.active_household_id = m.household_id
         WHERE m.user_id = ai_usage_events.user_id
         LIMIT 1),
       (SELECT m.household_id
          FROM household_members m
         WHERE m.user_id = ai_usage_events.user_id
         ORDER BY m.joined_at, m.household_id
         LIMIT 1)))
 WHERE household_id IS NULL;

UPDATE ai_usage_events
   SET funding = CASE key_source WHEN 'server' THEN 'platform' WHEN 'user' THEN 'household' END
 WHERE funding IS NULL AND key_source IN ('user', 'server');
```

Notes the implementation must honour:

- **The capability INSERTs repeat the join on `household_members`** on purpose: it both resolves the
  role (owner wins) and drops a legacy row whose user has no household — the column is `NOT NULL`, so
  an unmatched row must be skipped, not inserted as NULL.
- **A user in two households gets their provider in exactly one** — the active/oldest one, never
  duplicated. Switching households at runtime switches the provider set with it, which is the point of
  the household scope.
- **The backfill leaves `default_model` NULL.** Legacy rows already carry per-capability models
  (`ai_model` / `ai_vision_model`), so the new provider-level default starts empty; the owner may set
  one alias per key afterwards and blank capability models inherit it (§5.1).
- **Multi-member households keep every key but only one assignment set.** Member B's old key becomes a
  provider row (`… · Bob #2`) they can be assigned later; until then B's calls use the household's
  assignment and are billed to the owner's key. That is the intended consequence of D1, not an
  accident — it is called out in the release note and in risk 7.
- A legacy `ai_provider = 'custom'` row with **no** `ai_base_url` is migrated as-is and stays broken in
  exactly the same way (the old dispatcher threw at call time, `ai.ts:506-511`). It must **not**
  silently become an OpenAI call: `preset = 'custom'` has no canonical endpoint, so the row resolves as
  unusable (log line, not configured → 402) and the Settings screen flags it "needs a base URL".
- The provider INSERT repeats `ai_provider IS NOT NULL` on purpose: a user can hold a key with no
  provider chosen (`PATCH /api/settings` accepts `ai_key` alone), and such a row has no
  `legacy-…` provider to reference — the FK would abort the whole migration.
- All provider/capability statements filter `encrypted_ai_key LIKE 'v1:%'` for the same reason: one
  hand-edited non-envelope ciphertext would fail the `ai_providers.encrypted_key` CHECK and abort the
  entire migration. Such a row is skipped (its key could never be decrypted anyway) and the user lands
  in the normal "not configured" state instead of blocking everyone else's deploy.
- `thinking_level` for `vision` is forced NULL: 0033 never had one, and the CHECK above requires it.
- The migration is **idempotent only in the sense of not re-running**: wrangler tracks filenames, and
  the legacy ids are deterministic. A re-run on a migrated DB would violate the provider PK — that is
  the intended loud failure, not silent duplication.
- **`ai_model`-less users (provider + key, no model) are NOT configured by the backfill.** The provider
  row is created, but P1 deletes the adapter's model default (§4.5), so the migration leaves the
  legacy value (NULL or `''`) on all three assignments and `default_model` NULL: the resolver answers
  402 / the settings payload reports `status: none` until an owner types a model. That is the one
  behavior change for a backfilled account (the release note below says so), and it is deliberate —
  filling `default_model` from the old per-provider default here would re-introduce the vendor
  aliases the owner decision retired. Nothing is discarded: the key and the row stay, and one model
  on the provider restores every capability that inherits it.
- The backfill copies the **`v1:` envelope verbatim**. It does not re-encrypt: the AAD-bound `v2:`
  form arrives with P2, and each row converts on its first read (§3.6). Nothing in the migration
  depends on `crypto.ts` changing first, and no user re-enters a key.

### 3.4 No server fallback — `RUMAQ_SERVER_AI_*` is retired (D8)

**Owner decision, 2026-11-07.** There is no implicit provider and no shared server key. Resolution
for a capability is exactly: the caller's own assignment → `not_configured` (402). A new account is
empty, and an account that has not configured a capability is _unconfigured_, never silently served
by the platform.

**Removed in P1, with the resolver swap** — not later, because leaving the branch alive would keep
two ladders in the code and two truths in the docs:

| Removed                                                       | Where it is today                                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server branch of the resolver                             | `backend/src/lib/ai-access.ts:114-130`                                                                                                                                     |
| The server provider allowlist                                 | `ai-access.ts:70-76` (`SERVER_PROVIDER_PRESETS`)                                                                                                                           |
| The env bindings                                              | `backend/src/types.ts:43-45` (`RUMAQ_SERVER_AI_{PROVIDER,KEY,MODEL}`)                                                                                                      |
| The "leave `RUMAQ_SERVER_AI_*` undeclared" comment            | `backend/cloudflare.config.ts:116-119`                                                                                                                                     |
| The "shared server key is uncapped" paragraph                 | `docs/ARCHITECTURE.md:313`                                                                                                                                                 |
| `server_ai_available` in the settings payload                 | `backend/src/apps/api.ts:1114` — dropped in P3 together with the UI option that reads it                                                                                   |
| Four test suites plus the env fixture that build the fallback | `ai-access.test.ts`, `documents-ocr.test.ts`, `api-routes.test.ts`, `review-ai.test.ts`, `__tests__/support/env.ts` — rewritten to seed provider + capability rows instead |

No env var replaces them, and no new one is introduced. The QA Worker's copies are deleted by the
owner (a `docs/MANUAL_ACTIONS.md` entry created in P1); the deploy never wrote them
(`cloudflare.config.ts` leaves them undeclared on purpose), so no `scripts/` change is needed. After
P1 the variables are inert even if a Worker still has them — the code no longer reads them.

**QA and testing accounts are ordinary users.** `alice@rumaq` and `test@rumaq` get their rows in the
database through Settings, like anyone else:

- **decision** → one provider of kind `questions`, base URL `https://api.typesafe.ai/v1/systemone`,
  model `jev-latest`, and the owner's key. The key is entered once in Settings (a
  `docs/MANUAL_ACTIONS.md` item) — never committed, never an env var.
- **reasoning** and **vision** → a chat-capable provider the account already uses (kind
  `openai-compatible`, `gemini`, or `anthropic`, with its own model), because a `questions` provider
  answers only choice questions (§2.4).

**Automation seeds the same rows.** The harness setup step creates a provider and the three
assignments through the public endpoints the UI uses (`POST /api/ai/providers`, then
`PUT /api/ai/capabilities/{decision,reasoning,vision}`). Those endpoints only exist from **P3**, so P1
marks the AI automation scenarios that need a resolved provider pending (five API, five E2E; each with
a #523 reference) and P3 reactivates them against the new endpoints — there is no write-through to keep
the old `PATCH /api/settings` step meaningful,
because §4.3 removes the compatibility window on purpose. `TEST_MODE` still stubs the transport, so
seeded rows exercise the **resolver** without a real provider call — which is exactly why the rows must
exist. The "no AI key returns 402" scenarios stay honest by seeding nothing.

**Key provenance.** New usage rows record `funding = 'household'` (D9) and no longer write
`key_source`, whose column and historical values stay as history. Nothing in the product can spend a
platform key any more, so the admin views no longer need to distinguish a platform-paid call — but the
column is still there for the rows that were.

**No platform provider is seeded, now or later.** D9 reserves a `funding` dimension and D8 removes the
env fallback; together they mean v1 has no RumaQ-funded provider of any kind. A future premium mode
adds a provider row and a subscription check **inside the door** (§2.6) — it does not add an env var,
a per-user grant, or a call-site branch.

### 3.5 Uniqueness, deletion, ownership

| Rule                              | Where                                                 | Behaviour                                                                                                                       |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| One assignment per capability     | `PRIMARY KEY (household_id, capability)`              | `PUT /api/ai/capabilities/:capability` is an upsert                                                                             |
| Labels unique per household       | `idx_ai_providers_household_label`                    | 409 on create/rename                                                                                                            |
| Deleting a provider               | `ON DELETE CASCADE` on `ai_capabilities.provider_id`  | the capability becomes not configured → 402; DELETE reports `{ cleared: ['reasoning'] }`; the UI confirms first                 |
| Deleting a household              | `ON DELETE CASCADE` from `households` on both tables  | providers and assignments go with it; usage rows keep `household_id = NULL` (the tokens were still spent)                       |
| A member leaving or joining       | `household_members` only                              | the household's providers and assignments are untouched — the point of D1                                                       |
| Deleting a user                   | `ON DELETE CASCADE` from `users` on `ai_usage_events` | their usage history goes with the account; the household's configuration stays                                                  |
| Usage rows survive provider edits | no FK from `ai_usage_events` to `ai_providers`        | history stays readable after a provider is deleted (it stores kind + model + capability + household + funding, not provider id) |
| Who may manage                    | household role (`lib/households.ts:134-142`)          | `owner` creates/edits/deletes providers and assignments; `member` reads and uses them; 403 otherwise                            |
| Key secrecy                       | `encrypted_key` never serialised                      | `has_key` is the only signal any GET returns, for any role; the decrypted key only ever exists inside `lib/ai/**`               |
| Key material at rest              | `v2:` envelope + `ai_provider:<id>` AAD (D10)         | a ciphertext copied onto another row fails the GCM tag; `v1:` rows convert on first read (§3.6)                                 |

`ai_usage_events` stores the **kind** in `provider` (as today) plus `capability`, `household_id` and
`funding`; it does not store `provider_id`, because a deleted provider must not orphan or rewrite
history. Attribution is two-dimensional on purpose: `user_id` answers "who made the call", and
`household_id` answers "who paid for it" — the pair is what makes a shared key auditable.

### 3.6 Key material at rest — row-bound AAD (D10)

Today `encryptAiKey` (`crypto.ts:85-98`) seals a plaintext with AES-GCM and **no additional data**, and
`decryptAiKey` (`:100-111`) refuses anything that is not `v1:`. D10 adds one authenticated field — the
provider row id — and a second envelope version:

| Envelope | AES-GCM AAD        | Written by                                    | Read behaviour                                                     |
| -------- | ------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| `v1:`    | none               | everything before P2 (including the backfill) | decrypt, then **re-encrypt as `v2:` and UPDATE** (compare-and-set) |
| `v2:`    | `ai_provider:<id>` | P2 onward, every write                        | decrypt with the AAD; a transplant fails the authentication tag    |

Why the row id and not the household or the user: the provider row is the unit that gets copied (a
backup restore, a support export, a hand-rolled `INSERT`), and its id is immutable and generated by us —
`crypto.randomUUID()` at runtime, `legacy-<user_id>` in the backfill — so a copied ciphertext has no
valid context anywhere else. `additionalData` is one line on each side of `crypto.ts`; the tag covers it.

The read path, in `credentials.ts`:

1. `v2:` → decrypt with `aad(providerId)`. One attempt, no fallback: a tag mismatch is final.
2. `v1:` → decrypt **without** AAD (it still authenticates the ciphertext itself, just not the row), then
   `UPDATE ai_providers SET encrypted_key = <v2> WHERE id = ? AND encrypted_key = <the v1 just read>`.
   The compare-and-set means two concurrent reads cannot fight; both would write the same `v2` value.
3. A `v1:` that fails to decrypt, or a `v2:` whose tag fails → the row is unusable: log, do not throw,
   resolve to not configured (§5.1). Never a 500.

Cost and failure handling:

- The rewrite is **one extra subrequest, once per legacy row** — not per call. The sweep resolves once
  per run, so the worst case is one extra write per run until every row has been read.
- The settings read model (`loadHouseholdAiConfig`) decrypts with `{ reseal: false }`: a
  `GET /api/settings` must not write, so a legacy row is migrated by its next real provider call.
- A failed rewrite must **not** fail the call: the decrypted key is already in memory; the UPDATE is
  best-effort, logged, retried on the next read.
- No user-visible change, no forced re-entry, no downtime window: P1 copies `v1:` verbatim and P2
  converts lazily.

What it buys, and what it does not:

- **Buys**: a ciphertext copied from provider A to provider B (or from a backup onto a row an attacker
  created) fails to decrypt, because the tag covers the AAD. Before D10 that transplant **succeeds** —
  it is the one way a database-level attacker could redirect a household's key to their own endpoint.
- **Does not buy**: protection from someone holding both the ciphertext _and_
  `WORKER_ENCRYPTION_KEY`; rotation semantics are unchanged (rotating the key still invalidates every
  row — risk 2); and rows still on `v1:` stay transplantable until their first read. That residual
  window is exactly why this lands in P2, in the same breath as the door, and not in some later tidy-up.
- **A deleted provider row's ciphertext becomes useless immediately**: the id is gone, the app never
  re-creates a row with the same id (`legacy-…` ids come only from a migration that cannot re-run), and
  the AAD cannot be reconstructed from the ciphertext. A backup copy restores only if the row itself is
  restored with the same id — which is what a legitimate restore does.

---

## 4. Settings API + UI

### 4.1 Endpoints

All routes act on the **resolved household** (`c.get('householdId')`), never on a user id: switching
households switches the provider set, which is the point of D1. Reads are open to every member; every
write goes through `requireOwner` (`lib/households.ts:134-142`) and answers 403 for a member. All are
authenticated and registered in the existing `apiApp.use(..., propsAuthMiddleware)` block
(`apps/api.ts:621-669`) — a missed entry is an unauthenticated route, so the phase test asserts each
new path 401s without a session.

| Method        | Path                               | Purpose                                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`         | `/api/ai/presets`                  | The catalog of presets a user MAY add: id, label, kind, canonical base URL. Seeds nothing, preselects nothing, and defines no default — no model ids either, since those are the owner-typed `ai_providers.default_model`/capability data. **The one place the UI learns vendors from.** |
| `GET`         | `/api/ai/providers`                | `{ can_manage, providers: [{ id, label, kind, base_url, default_model, has_key, created_at, updated_at }] }` — never the key; `can_manage` is the household role, so the UI never guesses                                                                                                |
| `POST`        | `/api/ai/providers`                | Owner only. Create `{ label, kind, base_url?, default_model?, api_key, preset? }` → 201 with the row                                                                                                                                                                                     |
| `PATCH`       | `/api/ai/providers/:id`            | Owner only. Update `{ label?, kind?, base_url?, default_model?, api_key? }`; `api_key: ''` clears it, omitted leaves it; `default_model: ''` clears the default                                                                                                                          |
| `DELETE`      | `/api/ai/providers/:id`            | Owner only. Delete + cascade; returns `{ cleared: Capability[] }`                                                                                                                                                                                                                        |
| `POST`        | `/api/ai/providers/:id/test`       | Owner only. Test connection (see §4.6). Body `{}`                                                                                                                                                                                                                                        |
| `GET`         | `/api/ai/capabilities`             | `{ capabilities: { decision: { provider_id, model, thinking_level, source: 'household'\|'none', provider_label } , … } }`                                                                                                                                                                |
| `PUT`         | `/api/ai/capabilities/:capability` | Owner only. Upsert `{ provider_id, model?, thinking_level? }`                                                                                                                                                                                                                            |
| `DELETE`      | `/api/ai/capabilities/:capability` | Owner only. Clear the assignment (the capability becomes not configured)                                                                                                                                                                                                                 |
| `GET`         | `/api/ai/usage`                    | Existing (`api.ts:1439`) + per-capability breakdown for today. Scoped to the **acting user** — "your calls", not the household's                                                                                                                                                         |
| `GET`         | `/api/admin/ai/usage`              | Existing (`api.ts:1523`) + per-capability and per-household totals (the funding view D9 will need)                                                                                                                                                                                       |
| `GET`/`PATCH` | `/api/settings`                    | Unchanged shape + additive `ai_providers`, `ai_capabilities`, `ai_status { decision, reasoning, vision: 'household'\|'none' }`. In P3 the legacy `ai_*` fields, `has_ai_key` and `server_ai_available` are **removed** together with the columns (D8, §4.3)                              |

`POST /api/ai-key/test` (`api.ts:1298`) is **removed in P3** together with the legacy settings fields,
superseded by `/api/ai/providers/:id/test` (§4.6).

### 4.2 Validation

Valibot schemas in `backend/src/schemas.ts` beside the existing `settingsPatchSchema:26`:

- `kind` — `picklist(['openai-compatible', 'anthropic', 'gemini', 'questions'])`.
- `label` — `pipe(string(), minLength(1), maxLength(60))`, trimmed; unique per household (409).
- `base_url` — `maxLength(500)`, trimmed, trailing slashes stripped, **HTTPS only** (the existing
  rule, `api.ts:1198-1200`), required when `kind = 'questions'` or when no canonical endpoint
  exists for the kind. HTTP / private-network endpoints are rejected (§7.2).
- `api_key` — `minLength(1)` on create, trimmed, encrypted **before** the INSERT with the provider's own
  id as AAD (`encryptAiKey(key, WORKER_ENCRYPTION_KEY, 'ai_provider:' + id)`, `crypto.ts:85`), so the
  stored envelope is `v2:` (D10, §3.6) — the id is therefore generated first, never derived from the
  ciphertext. Never echoed, never logged; `has_key` is the only signal the API returns.
- **An assignment requires a usable provider**: the target row must have an `encrypted_key` and a
  resolvable endpoint (its own `base_url` or its preset's). Clearing a key on an assigned provider is
  a 409, not a silent downgrade ("this provider is used by reasoning — reassign first").
- `model` — the existing `AI_MODEL_REGEX` (`schemas.ts:24`) and 200-char cap. It is load-bearing:
  Gemini interpolates the model into the URL path (`ai.ts:312-315`). `default_model?` on provider
  create/update uses the same regex and cap; it is optional, and an empty string clears it.
- `thinking_level` — `low|medium|high|''`; rejected (400) for `vision` and for `kind = 'questions'`.
- **Cross-field checks** (server-side, not just UI): provider kind must `supports(capability)`; a
  capability assignment must reference a provider of the **caller's household**
  (`WHERE id = ? AND household_id = ?`, so a leaked id from another household is a 404, never a 403
  that would confirm it exists).
- **Role checks come first on every write**: `requireOwner(db, c.get('householdId'), c.get('userId'))`
  → 403 `Only household owners can change AI settings`, before any row is touched. Reads skip the
  check on purpose: a member must see what their household is spending.
- **There is no implicit assignment.** `PUT /api/ai/capabilities/:capability` is a 404 when the
  household has no provider with that id, and nothing creates a provider or an assignment on the
  household's behalf — not the migration, not the UI, not the first AI request.

### 4.3 No compatibility window — the columns die with the screen (owner-decided)

The owner's call is blunt: **no customer uses the legacy `user_settings.ai_*` fields, and temporary
breakage is acceptable.** So there is no read-through, no write-through and no deprecation shim. The
old columns are left untouched by P1, stop being read by anything the moment the resolver swaps
(§5.1), and are **dropped in P3** — the same PR that ships the new Settings section.

What that means concretely:

- **P1 and P2 leave `user_settings.ai_*` exactly as they are.** No migration touches them, no route
  writes them differently. The old Settings screen still renders and still `PATCH`es successfully
  (200), but those writes are **dead**: the resolver reads `ai_providers` / `ai_capabilities`, so an
  edit changes nothing about the next AI call. That is the accepted breakage, and it is why the
  release note matters.
- **P3 removes both halves at once**: the new endpoints and section arrive, the legacy AI fields leave
  `GET/PATCH /api/settings`, `has_ai_key` and `server_ai_available` go with them
  (`api.ts:1113-1114`), `USER_AI_SETTINGS_COLUMNS` / `loadUserAiSettings` are deleted, and
  `0040_drop_legacy_ai_settings.sql` drops the six columns. Screen and schema can never disagree,
  because there is no window in which both exist.
- **`POST /api/ai-key/test` goes in P3** with the fields it validates (`aiKeyTestSchema`,
  `schemas.ts:54`); its replacement lands in the same PR.
- **Migration numbering**: `0039` (P1, additive) and `0040` (P3, destructive drop). P6 — previously the
  home of the drop — is deleted: a phase whose only job is cleanup stops existing once the cleanup
  rides with the change.
- **Deployment order**: P3 is the first release that must go out with a **D1 backup taken immediately
  before deploy**, because `DROP COLUMN` is not reversible in code. P1 and P2 revert with a plain
  `git revert`; P3 reverts only by restoring that backup (or by re-adding empty columns, which would
  leave every household unconfigured).
- **The one real cost, stated plainly**: between P1 and P3 a household can **use** AI but cannot
  **change** it — the old screen is a no-op and a broken key cannot be re-entered until P3 lands.
  Mitigation is release discipline, not code: P1+P2+P3 ship to the QA deployment as one release, and
  risk 5 tracks it.

### 4.4 Screen structure — Settings → AI

One section. **Two states, and the empty state comes first.** The section is **household-scoped**: what
it shows is what the household's members will spend on their next call.

**Who sees what.** A member sees the same data read-only: providers listed without Add/Edit/Delete/
Test, assignments shown as status lines, and one sentence naming the decision maker ("Managed by
Alice — ask them to change it"). The empty state for a member says "Ask your household owner to add a
provider." Every manage affordance is gated on `can_manage` from `GET /api/ai/providers`, never on a
client-side guess about the role.

**State A — no provider yet** (`providers.length === 0`), for every new household:

1. **Lead copy** — "RumaQ uses AI in three places: decisions, chat and plans, and reading receipts
   and documents. Add a provider to turn any of them on."
2. **"Add your first provider"** — the only action, opening the form (preset picker with **no
   preselection**, or the advanced protocol form).
3. **Capability summary** — read-only lines for Decision / Reasoning / Vision, each saying **"Not
   configured"**, with the existing consequence spelled out per line ("Review stays manual", "Chat
   is unavailable"). No `<select>`, no model input, no prefill: **capability selection does not exist
   until at least one provider does.**

**State B — at least one provider:**

1. **Lead copy** — same sentence, plus the resolved reminder ("Changes apply to the next AI call").
2. **Capability cards** — three rows in the existing `Setting` component:
   - **Decision model** — "Structured choices: review verdicts, classification, JSON answers."
     Provider `<select>` listing only the household's providers (nothing preselected; the first option is
     "Choose a provider") — **no "use server default" option exists** (D8); model input whose
     placeholder is the adapter's default; thinking select (hidden when the provider has none).
   - **Reasoning model** — "Chat and shopping plans." Same shape.
   - **Vision model** — "Reading receipts and documents." No thinking select.
     Each card renders its resolved source as a status line: _"Using <label>"_ or _"Not
     configured"_. There is no third state.
3. **Providers** — list rows (label, kind, base URL, key state) with **Test**, **Edit**, **Delete**
   for owners (members: the same list, no buttons); the **Add provider** form (preset picker, nothing
   preselected; advanced: kind + base URL + model for a typed-decision endpoint). Deleting a provider
   that is assigned shows which capabilities will become **not configured** before the confirm.
4. **Usage** — today's calls/tokens for the acting member, broken down by capability, with the
   household total beside it (readable by every member; the admin view owns the cross-household cut).

The legacy provider/model/thinking inputs (`Settings.jsx:351-437`) are removed in P3; nothing in the
UI reads `ai_model` after that.

### 4.5 Copy and defaults

- **No vendor is a default.** `presets.ts` carries only the catalog a user may choose from (the six
  presets that exist today: OpenAI, OpenCode, Anthropic, Gemini, Ollama, custom). There is no seeded
  provider, no preselected preset, and no copy that implies one. A typed-decision endpoint is
  configured through the advanced form — kind `questions` + base URL + model — and this document
  mentions "Jev" only as the owner's concrete example of such an endpoint, never as a preset id.
- The **only** default the UI offers is per chosen provider: the provider form has an optional
  "default model" field (`ai_providers.default_model`), and every capability that leaves its own
  model blank inherits it — `capability.model ?? provider.default_model ?? not configured` (owner
  decision 2026-11-07). Leaving BOTH blank is a normal not-configured state (402), not the adapter's
  `defaultModel(capability)`: the hardcoded `gpt-4o-mini` / `gemini-3.6-flash` / `claude-3-haiku-20240307`
  / `glm-5.3-flash` fallbacks are deleted with P1's resolver swap, so no vendor alias ages in code.
  The field is free text (floating aliases like `chatgpt-4o-latest` or an Ollama `:latest` tag are the
  point), validated by the existing model regex/cap only.
- i18n: new keys under `settings.ai.*` in `frontend/src/i18n/locales/{en,id}.json`, both languages in
  the same PR (the `visionModelDesc` precedent at `en.json:587`).

### 4.6 What "test connection" means per kind

| kind                | Request                                                         | Cost                                                                          |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `openai-compatible` | `GET {base}/models` with the decrypted key                      | free                                                                          |
| `anthropic`         | `GET https://api.anthropic.com/v1/models` + `anthropic-version` | free                                                                          |
| `gemini`            | `GET /v1/models?key=…`                                          | free                                                                          |
| `questions`         | `POST {base}` with an **empty `questions` object**              | **free** — a 400 proves the key authenticates without buying an answer (§7.2) |

**The typed probe is deliberately a malformed request.** `{"state": "", "model": <assigned>, "questions": {}}`
is expected to come back `400` or `422` — an error that proves the key authenticated while buying no
answer. This is **pending confirmation from Jev** and is recorded as a `docs/MANUAL_ACTIONS.md`
verification item in P3; if the endpoint 500s or bills on an empty body, the fallback is the billed
micro-question (one trivial question over the assigned model, labelled as billable in the UI and
rate-limited like OCR — `plugins/documents/ocr.ts:46-54`).

The test is owner-only (it may spend the household's credential budget) and never uses a stored
provider's key for a _different_ provider. The response is `{ ok: true }` / `{ ok: false, code }` —
never the provider body verbatim (it can echo key material in error messages).

---

## 5. Runtime

### 5.1 Resolution precedence

```
resolveAccess(ctx, capability):
  row = SELECT c.model, c.thinking_level,
               p.id, p.kind, p.preset, p.base_url, p.default_model, p.encrypted_key
          FROM ai_capabilities c JOIN ai_providers p ON p.id = c.provider_id
         WHERE c.household_id = ? AND c.capability = ?       -- 1 subrequest, 1 join

  model = row.model ?? row.default_model                     -- owner rule, #523
  if not model:                                              -- neither set: NOT configured
    log '[ai] capability assignment has no model household=…'
    return null                                              -- routes answer 402

  if row and row.encrypted_key:                              -- no key: row is unusable
    baseUrl = row.base_url ?? presetEndpoint(row.preset)     -- presets.ts, null for 'custom'
    if baseUrl or row.kind != 'questions':                   -- questions has no canonical endpoint
      try:   key = decryptProviderKey(row)       -- v2: AAD · v1: legacy + lazy rewrite (§3.6)
      catch: log '[ai] stored provider unusable household=…' -- never 500
      else:  return handle(model=model, funding='household')
  else:
    log '[ai] capability assignment has no usable provider household=…'   -- Settings flags it

  return null                                                -- routes answer 402
```

The household is the lookup key, not the user: two members of the same household resolve the **same**
row (and therefore the same key), which is exactly what D1 asks for. The acting `userId` never enters
this query — it only appears when the usage row is written (§5.3), so a member can never be served a
different provider than the one the owner configured.

There is no server branch (D8): an unconfigured capability is unconfigured, and the ladder above is
the whole ladder.

Rules that make this honest:

- **The household's own rows are the only source.** There is no env key, no shared provider, and no
  "platform default" to fall back to (D8). The only default in the system is the provider's
  `default_model` — owner-typed data on a row the household chose — never a model name compiled into
  the adapters (`capability.model ?? provider.default_model`, else not configured).
- **A broken stored key is not a 500.** An undecryptable ciphertext or an unusable row (missing key,
  no resolvable endpoint) is logged, treated as not configured, and shown as "needs setup" in
  Settings — the same 402 a household would get with nothing configured, instead of today's
  inconsistency where chat/scan throw 500 on an undecryptable key.
- **`not_configured` is a normal state**, not an error: the review layer keeps degrading assist/auto
  to manual (`review-ai.ts:727-740`), routes keep 402.
- **Empty means empty.** A new household has no rows for any capability, so `resolveAccess` returns
  `null` for every capability. No code path invents a provider, a model, or a vendor.
- **`funding` is decided here, once.** Every handle v1 can return is `'household'`; the day a platform
  provider exists, this function is the only place that decides which one it is, and §2.6's meter is
  the only place a limit is applied.

### 5.2 Error and timeout normalisation

```ts
class AiError extends Error {
  code:
    | 'not_configured'
    | 'unsupported'
    | 'auth'
    | 'rate_limited'
    | 'timeout'
    | 'provider_error'
    | 'invalid_response'
  httpStatus: 402 | 500 | 502
  call: AiCall
  usage: TokenUsage // whatever the provider reported before failing
  providerStatus?: number
  retryable: boolean
}
```

| code               | cause                                                         | HTTP | note                                                                                                                   |
| ------------------ | ------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `not_configured`   | no assignment for the capability, or its provider is unusable | 402  | unchanged route strings                                                                                                |
| `unsupported`      | kind cannot serve the capability                              | 500  | should be unreachable: save-time validation                                                                            |
| `auth`             | provider 401/403                                              | 502  | body truncated, key never echoed                                                                                       |
| `rate_limited`     | provider 429                                                  | 502  | `Retry-After` surfaced on the error, not re-sent as a retry                                                            |
| `timeout`          | our `AbortSignal` fired                                       | 502  | **same status as today** so client handling is unchanged; `code` carries the distinction                               |
| `provider_error`   | other 4xx/5xx                                                 | 502  | message keeps the provider label (`"Gemini request failed: 500 …"`) so existing route tests stay honest                |
| `invalid_response` | empty content, unparseable JSON, off-schema decision          | 502  | feature-level validation still runs after and can reject further                                                       |
| `quota_exceeded`   | platform funding and the household's meter is exhausted       | 402  | **reserved by D9**: unreachable in v1 (nothing is platform-funded); the only place a cap may live is the facade (§2.6) |

**No automatic retries in the facade.** Each retry is a subrequest against the 50-per-invocation cap
(`review-ai.ts:60-66`); the review sweep already retries on its next tick, and a 429 storm is a
credentials problem the user must see, not something to hide behind backoff.

**Timeouts** (the door's defaults, overridable per call):

| capability  | default | rationale                                                |
| ----------- | ------- | -------------------------------------------------------- |
| `reasoning` | 60 s    | chat/plan answers are long; no caller today has a budget |
| `decision`  | 20 s    | the review constant today (`review-ai.ts:85`)            |
| `vision`    | 30 s    | image upload + read                                      |

Implementation: `AbortSignal.timeout(ms)` combined with the caller's signal (`AbortSignal.any` when
available; otherwise a two-listener shim). A caller-cancelled request maps to `timeout` but is logged
distinctly.

### 5.3 Usage accounting

One row per provider call, on failure too, now carrying `capability`:

```sql
INSERT INTO ai_usage_events
  (id, user_id, ts, date, provider, model, capability, household_id, funding,
   input_tokens, output_tokens, cached_tokens)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

- `user_id` = the **acting member** — who made the call (attribution, not ownership).
- `household_id` = the household that owns the provider and pays for the call: it is `call.householdId`,
  i.e. the resolved request household, and P4's test pins that the two cannot differ.
- `provider` = the **kind** (`'openai-compatible'`, `'questions'`) — continues today's meaning.
- `model` = the model actually sent; NULL = adapter default.
- `capability` = the dimension the directive asks for.
- `funding` = `'household'` on every v1 row; the dimension D9 reserves for a metered platform mode.
- `key_source` is **no longer written** (D9 replaced it with `funding`). Historical rows keep theirs and
  the backfill maps them (`'server'` → `'platform'`, `'user'` → `'household'`); the column stays as
  history (it is not one of the six legacy `user_settings` columns P3 drops).
- The sweep keeps its single batched write (`review-ai.ts:650-662`); `document-ocr.ts` keeps its
  "audit every attempt" pairing (`:121-136`), now reading `err.call`/`err.usage` from `AiError`.
- **Typed calls are not token-billed, and the admin view says so.** The typed-decision wire reports no
  token counts, so such calls record `input_tokens = 0, output_tokens = 0, cached_tokens = NULL` and are
  distinguishable by `provider = 'questions'`; the admin breakdown renders them as **"typed — not
  token-billed"** instead of a misleading zero (owner-decided, §7.2). No counter is added in v1.

### 5.4 Adapter quirks (the per-provider knowledge, isolated)

| Concern       | `openai-compatible`                                                                       | `anthropic`                                                                                   | `gemini`                                                                                       | `questions`                     |
| ------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| Endpoint      | `{base}/chat/completions`                                                                 | `https://api.anthropic.com/v1/messages`                                                       | `…/v1beta/models/{model}:generateContent`                                                      | `{base}` (one POST)             |
| Auth          | `Authorization: Bearer`                                                                   | `x-api-key` + `anthropic-version: 2023-06-01`                                                 | `?key=` query param                                                                            | `Authorization: Bearer`         |
| System prompt | `role: 'system'` message                                                                  | top-level `system` string                                                                     | first `text` part (today) / `systemInstruction` (preferred)                                    | folded into `instructions`      |
| Thinking      | `reasoning_effort: low\|medium\|high`                                                     | `thinking.budget_tokens` 2048/8192/16384, `max_tokens > budget`                               | `thinkingConfig.thinkingBudget` 1024/8192/24576                                                | unsupported (validated at save) |
| Token cap     | `max_completion_tokens` for OpenAI-proper; `max_tokens` elsewhere; **omitted** for Ollama | `max_tokens` (derived from budget)                                                            | model default                                                                                  | n/a                             |
| Image part    | `image_url` data URI                                                                      | `{"type":"image","source":{"type":"base64",…}}`                                               | `inline_data`                                                                                  | n/a                             |
| JSON mode     | `response_format: {type:'json_object'}` **opt-in per call**                               | none (prompt only)                                                                            | `responseMimeType` (opt-in)                                                                    | native (typed answer)           |
| Usage fields  | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`             | `input_tokens` / `output_tokens`; cache read deliberately **not** folded in (`ai.ts:408-417`) | `promptTokenCount` / `candidatesTokenCount` + `thoughtsTokenCount` / `cachedContentTokenCount` | none                            |
| Model charset | free within `AI_MODEL_REGEX`                                                              | same                                                                                          | URL-path segment → must stay in `AI_MODEL_REGEX` (`schemas.ts:24`)                             | same                            |

The `json` flag stays **opt-in and off by default**: today no call sends a JSON-mode field, and
several OpenAI-compatible servers reject `response_format`. Prompts keep saying "return ONLY JSON";
`parseJsonResponse`'s fence tolerance stays the shared reader — and the `plans.ts:160` copy is
replaced by it (§2.5, one extraction policy).

### 5.5 How existing features map

| Feature                                     | Capability  | Today's model field           | After                                                       |
| ------------------------------------------- | ----------- | ----------------------------- | ----------------------------------------------------------- |
| Chat (`/api/ai/chat`)                       | `reasoning` | `ai_model`                    | reasoning assignment                                        |
| Shopping plan (`/api/plans/generate`)       | `reasoning` | `ai_model`                    | reasoning assignment                                        |
| Receipt scan (`/api/purchases/scan`)        | `vision`    | **`ai_model`** (bug)          | vision assignment                                           |
| Vault expiry OCR (`…/extract-expiry`)       | `vision`    | `ai_vision_model ?? ai_model` | vision assignment                                           |
| Match-review verdicts (route + cron)        | `decision`  | `ai_model` + thinking         | decision assignment                                         |
| Persona copy (browser)                      | `reasoning` | `ai_model`                    | reasoning assignment, server-side                           |
| Provider key test                           | —           | direct `/models`              | `POST /api/ai/providers/:id/test`                           |
| **Future** quick-add parse ("beli 2L susu") | `decision`  | —                             | decision assignment (`structured()`: item/qty/unit/store)   |
| **Future** product-name → category          | `decision`  | —                             | decision assignment (parity with the pipeline's classifier) |

The receipt-scan row is a behaviour **fix**, not a regression: a user who set `ai_vision_model`
expects it to read receipts. It gets its own test and a release note, and it rides P4 (not P1).

One nuance for review: a `questions` provider answers choice + confidence only, so
`review_ai_verdicts.reason` becomes NULL under a typed (`questions`) decision provider. The column
already allows NULL (`migrations/0038_review_ai.sql:49`) and the UI renders the reason when present;
the contract change is "reason is optional" (D3 accepts it).

---

## 6. Phased implementation plan

Each phase is one PR with its own rollback note. They are independently _revertible_, not
independently _usable_: P1 and P2 leave the settings UI unable to change AI until P3 ships the new
screen (§4.3), so P1+P2+P3 go out as one release. Every phase runs
`./scripts/test.sh unit backend` (plus `frontend` where touched), `./scripts/style.sh --check`, and —
when routes change — `./scripts/docs.sh` and `bunx vp run api:codegen` (CI diffs both artifacts,
`scripts/github/ci.sh:16-24`).

### P1 — Schema, household resolver swap, server-fallback removal

**The first PR, exactly:**

1. `backend/migrations/0039_ai_gateway.sql` — the two tables (including the optional
   `ai_providers.default_model`; the backfill leaves it NULL), indexes, CHECKs, backfill, and the
   `ai_usage_events` dimensions (§3.2–§3.3). The `encrypted_key` CHECK accepts **both** envelope
   prefixes (`v1:` legacy, `v2:` AAD-bound) from day one: SQLite cannot alter a CHECK without
   rebuilding the table, and D10's `v2:` writer arrives a release later.
2. `backend/src/lib/ai/{types,presets,credentials,capabilities,usage}.ts` — `resolveAccess(ctx,
   capability)` on the **new** tables, keyed by **`ctx.householdId`** and with the **two-outcome ladder**
   (assignment → null), resolving the model as `capability.model ?? provider.default_model` and
   treating "neither" as not configured; `buildAiUsageEventStatement`/`recordAiUsageEvent`/
   `deleteExpiredAiUsageEvents` moved here, writing `capability` + `household_id` + `funding`.
3. **The server fallback is deleted here, not later** (D8): `ai-access.ts:114-130`, the
   `SERVER_PROVIDER_PRESETS` allowlist (`:70-76`), the `RUMAQ_SERVER_AI_*` bindings
   (`backend/src/types.ts:43-45`), and the undeclared-vars comment (`cloudflare.config.ts:116-119`).
   `backend/src/lib/ai-access.ts` keeps its exported shape (`UserAiSettings`,
   `USER_AI_SETTINGS_COLUMNS`, `loadUserAiSettings`, `AiAccess`, `resolveAiAccess`) so no call site is
   touched; only its body changes.
4. `docs/ARCHITECTURE.md:313` loses the "shared server key is uncapped" sentence; §9's env table
   never listed the variables, so it needs no row removed. `docs/MANUAL_ACTIONS.md` gets one entry:
   delete `RUMAQ_SERVER_AI_{PROVIDER,KEY,MODEL}` from the QA Worker (they are inert after this PR but
   should not linger).
5. `GET /api/settings` gains the additive `ai_providers`, `ai_capabilities`, `ai_status` fields.
   **`PATCH` is not touched and gains no write-through** (§4.3): the legacy AI fields stay exactly as
   they are, write successfully (200) and change nothing the resolver reads. The columns themselves
   are also untouched here — P3 drops them with the screen.
6. Tests: `migrations.test.ts` (apply the chain in real SQLite; assert backfill row counts, the
   vision precedence, the case-insensitive label index, the CASCADE, the vision/thinking/funding
   CHECKs, that a user with no legacy AI settings gets **zero** provider and capability rows, and the
   household rules: a two-member household keeps **two** provider rows with distinct labels, only the
   owner's legacy values become assignments, a user with two memberships lands in exactly one
   household (the active one), legacy usage rows gain `household_id` + `funding`, and the
   `encrypted_key` CHECK accepts both `v1:` and `v2:`);
   `ai-access.test.ts` **rewritten** as the two-outcome matrix — assignment → row, undecryptable key →
   null, missing/unusable provider → null, empty account → null, and "env vars present but ignored";
   the four suites that constructed the fallback (`documents-ocr`, `api-routes`, `review-ai`, plus
   `__tests__/support/env.ts`) seed provider + capability rows instead; `api-routes.test.ts` asserts
   the settings payload with `ai_status` all `none` for a fresh household, that a legacy `PATCH /api/settings` with `ai_key` still returns 200 while leaving
   `ai_providers` and `ai_capabilities` **unchanged** — the documented dead write of §4.3. The AI
   automation scenarios that need a resolved provider (five API, five E2E — their setup is that same
   legacy `PATCH ... ai_key` dead write) are marked pending in this PR with a `#523` reference; P3
   reactivates them against the provider/capability endpoints.

**Not in P1:** no new endpoints, no new UI, no call-site edits, no adapter extraction, no column drop,
and **no legacy write-through**.
**Rollback:** revert the PR. The migration is additive, the legacy columns were never touched, and the
env fallback returns with the reverted code — so the old screen is fully live again after a revert.
**Release note:** from this PR until P3, Settings → AI accepts edits but they do nothing (§4.3), and a
broken key cannot be re-entered. An account that never typed a model — the field's documented
default, "leave empty to use its default" — is **not configured** after the swap (blank capability
models, `default_model` NULL) and every AI feature answers 402 until its owner sets a model on the
new screen; the backfill does not invent one (§3.3). P1, P2 and P3 ship to the QA deployment as one
release.

### P2 — The door: facade + protocol adapters

Move all provider transport into `lib/ai/adapters/*` behind `AiAdapter`; introduce
`lib/ai/index.ts` with `resolveAccess`/`completeText`/`vision`/`decide` and the `AiAccessHandle`
(module-private key). `lib/ai.ts` becomes a thin deprecated shim delegating to the door so the PR
lands without touching features; delete the shim in P4.

**Ciphertext binding (D10) lands in this PR**, because it is a `crypto.ts` + `credentials.ts` change
with no schema work (0039 already permits `v2:`): `encryptAiKey`/`decryptAiKey` gain an
`additionalData` argument and a `v2:` envelope (§3.6); `credentials.ts` decrypts `v2:` with
`ai_provider:<row id>` and `v1:` without it, then rewrites the row to `v2:` with a compare-and-set.
The write paths (create and key change) write `v2:` from here on; after P3 the legacy `PATCH` no
longer exists to write anything.

- Tests: an adapter contract suite driven by a fake `fetch` (one table of cases × 4 kinds: happy path,
  auth error, 429, 5xx, empty content, timeout via an aborted signal, usage mapping); the
  `decide()` shape across chat kinds vs the typed kind; `ai-boundary.test.ts` (the import/hostname
  rule) with an allow-list of exactly `lib/ai/**`; **crypto**: a `v2:` ciphertext copied onto another
  provider row fails to decrypt (D10's guarantee) while the same envelope in its own row succeeds, a
  `v1:` row decrypts and is rewritten exactly once (the second read is a no-op), a failed rewrite still
  returns the key and does not fail the call, and a tag/auth failure maps to `not_configured`.
- Rollback: revert; the shim and the old dispatcher come back, no schema change. **One caveat**: the
  ciphertext change is forward-only — reverted code decodes only `v1:`, so rows already rewritten to
  `v2:` would stop decrypting. The safe partial revert is to keep the P2 reader and revert only the
  writer (one line); a full revert means those owners re-enter their keys, with Settings showing
  "needs setup" and the assignments intact. Because the rewrite is lazy, that set is only "rows read
  since P2 was deployed", not the whole table.

**What P2 shipped, and where it deviated from this sketch.** The door (`resolveAccess` /
`completeText` / `vision` / `decide` / `structured`, the opaque handle with module-private key
material, the `AiError` vocabulary and the per-capability deadlines), the four wire adapters behind
`AiAdapter`, the shim + bridge delegation, and D10 in `crypto.ts` + `credentials.ts`. Deviations, all
recorded inline above: no `defaultModel()` on the adapter interface (owner-typed models only, §2.1/
§2.4); `AiError.call` is null for `not_configured` (§2.2); the boundary test ships with the two
pinned legacy exemptions P3/P4 empty (§2.3); the settings read model decrypts with `reseal: false`
(§3.6); `lib/ai/legacy.ts` is a P2-only bridge inside the door, deleted with the shims in P4 (§2.1).
The legacy vendor default models (`gpt-4o-mini`, `opencode-vision`, `claude-3-haiku-20240307`,
`gemini-3.6-flash`, `glm-5.3-flash`) are DELETED in P2 rather than P4: production always passes the
resolved assignment's model, so this is the owner decision of §4.5 finally enforced in code, and
the shim fails closed (`not_configured`) instead of inventing a model.

### P3 — Settings API + UI, and the legacy columns go (first user-visible PR)

Three halves of one change, deliberately in one PR because they are only safe together: the
`/api/ai/providers`, `/api/ai/capabilities`, `/api/ai/presets` endpoints with the provider test, the
Settings screen rebuild (§4.4) with en+id copy, and **the removal of the legacy surface** —
`0040_drop_legacy_ai_settings.sql` drops `ai_provider`, `encrypted_ai_key`, `ai_base_url`, `ai_model`,
`ai_vision_model`, `ai_thinking_level`; `GET/PATCH /api/settings` lose those fields plus `has_ai_key`
and `server_ai_available` (`api.ts:1113-1114`); `USER_AI_SETTINGS_COLUMNS` and `loadUserAiSettings` are
deleted; `POST /api/ai-key/test` (`api.ts:1298`, `aiKeyTestSchema`) and the "use server default" option
(`Settings.jsx:487-500`) go with them. `docs/API.md` is regenerated in the same PR.

`0040_drop_legacy_ai_settings.sql` is six statements:

```sql
-- 0040_drop_legacy_ai_settings.sql — D1 runs SQLite >= 3.35, so DROP COLUMN is native.
-- If a future engine predates it, use the 12-step table rebuild from 0021 instead.
ALTER TABLE user_settings DROP COLUMN ai_provider;
ALTER TABLE user_settings DROP COLUMN encrypted_ai_key;
ALTER TABLE user_settings DROP COLUMN ai_base_url;
ALTER TABLE user_settings DROP COLUMN ai_model;
ALTER TABLE user_settings DROP COLUMN ai_vision_model;
ALTER TABLE user_settings DROP COLUMN ai_thinking_level;
```

- Tests: route tests for CRUD, 401 without a session, **403 for every write as a member and 200 for
  their reads**, 404 on a provider id from another household, 409 on a duplicate label, 400 on
  kind/capability mismatch, 400 on `vision` + thinking, 404 assigning a provider that does not exist,
  cascade reporting on delete; `Settings.test.jsx` for the member's read-only section (no
  add/edit/delete/test, "Managed by …" line), the **empty state** (no capability selectors until a
  provider exists, nothing preselected), the three capability cards, add/delete provider, "becomes not
  configured" warning, and the absence of any server-default affordance; the automation setup step
  moves to `POST /api/ai/providers` + `PUT /api/ai/capabilities/*` and the three pending scenarios are
  reactivated; `migrations.test.ts` proves the six columns are **gone** and that a fresh database still
  reaches a working Settings payload.

- Rollback: **not a plain revert** — the columns are gone. The PR ships with a D1 backup taken
  immediately before deploy (`scripts/` backup path); restoring it is the only complete rollback.
  Re-adding empty columns would leave every household unconfigured, so it is not offered as a
  substitute. This is the single phase in the plan with that property, which is why it is called out
  here and in risk 5.

**What P3 shipped, and where it deviated from this sketch.** The endpoints, the two-section screen,
and the legacy removal all landed together, as designed. Deviations, all recorded inline above:

- **The migration is `0042_drop_legacy_ai_settings.sql`, not `0040`.** P1 shipped as 0041 (the
  numbering here was illustrative); 0042 is the next free number. The six `DROP COLUMN` statements
  are unchanged.
- **The provider test is per kind, not one shared request.** `POST /api/ai/providers/:id/test`
  delegates to `probe()` on the resolved adapter — `GET {base}/models` for the chat wire kinds, and
  the EMPTY-questions `POST` for `questions` (the only probe that can validate that wire). Keeping the
  probe inside the adapter is what left `apps/api.ts` free of provider hostnames, so
  `ai-boundary.test.ts`'s legacy-hostname exemption list is now **empty** (P4's job, done a phase
  early). A provider failure answers **200 with `{ok:false, code}`**, not an error status: the
  endpoint reports an outcome the UI renders, while 400 is reserved for "there is nothing to probe"
  (no key, no endpoint) and 429 for the per-user rate limit.
- **The household comes from the auth middleware, not a settings projection.**
  `resolveAiAccess(env, householdId)` takes the `householdId` `propsAuthMiddleware` already resolved;
  `USER_AI_SETTINGS_COLUMNS` and `loadUserAiSettings` are gone with the columns they projected. A
  cross-household provider id is a 404, not a 403 — its existence is not disclosed.
- **An edit cannot silently leave an assigned capability unusable.** A call needs three inputs — key,
  endpoint and model — so the write refuses to remove the last of any of them:
  - clearing the **key** of an assigned provider is a **409**;
  - clearing the **default model** while an assignment inherits it (its own `model` is blank) is a
    **409** naming the capabilities;
  - clearing the **base URL** is a **400** (`needs a base URL`) only when the row would have no
    endpoint left — its own URL, a preset's canonical endpoint or the kind's own endpoint. A clear
    that falls back to a preset endpoint is allowed, because the assignment does not go dark.

  The owner clears or reassigns the capability, then edits. Deleting a provider still cascades and
  the delete response reports the cleared capabilities, which is what the UI's confirmation names.

- **`PATCH /api/ai/capabilities/:capability` is `PUT`, and a clear is a DELETE.** The assignment is a
  singleton per (household, capability), so PUT is the honest verb; "choose the empty option and
  save" in the UI is a DELETE.
- **The automation reactivation was ten scenarios, not three.** Five API (chat, both usage, plans,
  scan) and five E2E (three plan flows, the cached-verdict assist, the receipt scan) were marked
  pending in P1; all ten now set up through `POST /api/ai/providers` + `PUT /api/ai/capabilities/*`
  (`configureAi` in the API helpers, `ai-setup.js` in the E2E steps). The typed `questions` wire is
  covered by backend tests only — a typed provider is a single-capability (decision) choice with no
  chat surface to drive from the UI.
- **A capability reports its own model next to the resolved one.** `GET /api/ai/capabilities` and the
  `ai_capabilities` block of `GET /api/settings` carry `model` (the assignment column; null = inherit
  the provider default) **and** `effective_model` (`model ?? provider.default_model`). §4.1 sketched a
  single `model`; the Settings form edits the column, and reporting only the resolved value made a
  blank field clear a pinned model on any save (review A2).
- **The browser-side persona rewrite is paused, not dropped.** The P5 scope below still moves it
  behind the door; until then `Settings.applyPersona` saves the persona and applies the built-in
  copy, but does not call `regenerateCopy()`. The provider/base-URL/model fields that call read were
  dropped with the columns (§4.3), so leaving it wired would have sent a stale browser key to a
  guessed vendor (or thrown on the deleted identifiers).
- **The retired copy went with the fields.** `has_ai_key`/`server_ai_available` no longer exist, so
  `/api/ai/usage` stopped returning `key_source`, the usage meter has no "shared server key" sentence,
  and the Plan and Assistant empty states now say to set AI up in Settings instead of asking for a
  key. `frontend/src/lib/aiStatus.js` holds the one predicate that maps `ai_status` to "AI is
  configured", mirroring the P2 bridge's reasoning → decision → vision ladder until P4 routes each
  call site.

### P4 — Call sites route by capability

Chat/plans → `reasoning`; scan/expiry OCR → `vision`; review (route + cron) → `decision` via
`decide()`; usage rows carry `capability` + `household_id` + `funding`; `/api/ai/usage` and
`/api/admin/ai/usage` gain the breakdown (and the household cut); delete `lib/ai.ts`,
`ai-access.ts`'s access types, and the `plans.ts` inline JSON parse; resolve once per run in the sweep
and pass the handle.

- Tests: per-route capability assertions (a fake provider records the capability it was called for),
  scan uses the vision model (the fix), review verdict from a typed provider (reason NULL) and from a
  chat provider (reason present), an empty household gets 402 on every AI route and the review sweep
  makes **zero** calls (still degrading to manual), usage rows include capability + household +
  funding, a call made by a **member** records that member's `user_id` with the household's
  `household_id`, the sweep still writes **one** batch and reads **one** capability row per run.
- Rollback: revert; P3's UI edits and P1's data stay valid, chat/plans/scan revert to the shim.

**What P4 shipped, and where it deviated from this sketch.** Every call site moved onto its
capability, the three shims were deleted, and the boundary test's exemption lists were removed rather
than left empty (a shim that came back would have to re-open the rule, not inherit an exemption).
Deviations, recorded where they landed:

- **The review's prompt became an ask, and its strict parse moved into the door.** The reviewer now
  calls `decide()` with `state` = the pair's display fields + flag (JSON, no ids), `criteria` = the
  identity rubric (including the ignore-embedded-instructions boundary) and `choices` =
  `same`/`different`. The door guarantees the choice list and clamps confidence, so
  `parseReviewVerdict`/`ReviewAiError` are gone; the feature keeps only its own policy
  (`reviewVerdictFromDecision`: an unreported confidence is 0 and cannot clear the auto floor, the
  reason is trimmed/capped, a typed provider's `reason: null` is stored as NULL). The cached verdict's
  `provider` column now records the wire kind (`openai-compatible`, `questions`, …), which is what
  every usage row has stored since 0041 — the legacy vendor id no longer exists to record.
- **The scan/OCR prompts and parsers moved into their features.** `buildScanPrompt` +
  `parseScanResult` live in `lib/receipt-scan.ts`; `buildExpiryExtractionPrompt` +
  `parseExpiryExtraction` live in `lib/document-ocr.ts`. Plans now validate the answer with its own
  `planGenerateResponseSchema` after the shared `parseJsonResponse` (the inline `content.match`
  copy is gone; an unparseable answer is a 502, not a silently empty plan). The schema keeps `why`
  **optional**, matching `planCreateSchema` and the retired mapper: requiring it made one cosmetic
  omission fail the whole plan, which the save route would have accepted (P4 review A2).
- **`usageCollector` is deleted with the shims.** The door returns the call's usage on success and
  `AiError.usage` on failure, so no call site accumulates tokens by hand; the scan/OCR failure path
  still bills the attempt from `AiError`. A failure raised AFTER a successful call — an unparseable
  scan reply, or a plan answer that fails the schema (an `invalid_response` carrying
  `call`/`usage`) — records the captured attempt too: the provider was billed even though its answer
  was unusable (P4 review A1; the route used to record it from the retired `onUsage` callback).
- **The legacy 2000-token output cap is gone, deliberately.** The deleted `lib/ai/legacy.ts` applied
  `maxTokens: 2000` for the `openai`, `opencode` and `custom` wires (gemini had none, anthropic
  defaulted to 2000 in its adapter, ollama never had one). No call site passes `maxTokens` any more,
  so those requests carry no cap field and the provider's own default applies; the door's per-call
  deadline (`AI_TIMEOUT_MS`) is what bounds a reply now. A household's own key pays either way, and
  a plan or chat answer is no longer truncated at ~1,500 words (P4 review C2).
- **`GET /api/ai/usage` loses `provider` and gains the cuts.** A household can point each capability
  at a different provider, so a single `provider` field would name one of three rows; the response is
  now the acting member's totals + a `capabilities` breakdown (with `typed_calls`, the not-token-billed
  count) + the household total. The Settings usage meter renders that breakdown, and `isAiConfigured`
  asks about the capability the feature calls (`reasoning` for chat/plans) instead of the retired
  reasoning → decision → vision ladder. The admin endpoint adds `totals.capabilities` and a
  `households` array; the admin page's rendering of the typed caption is left for P5.
- **The sweep's one capability read is structural, not incidental.** `resolveReviewAiAccess` returns
  `{ access, householdId }` for `decision`; the route and the cron both resolve once and pass the
  handle + household down, and `evaluatePendingReviews` writes the run's usage rows in one batch. A
  test counts the `ai_capabilities` JOIN (exactly one per run) and the `db.batch` calls (one for the
  usage rows) to pin both.
- **`aiConfigured` on the review mode/evaluate routes now means "the decision capability is usable"**,
  which is exactly what those routes need; before P4 it meant "the bridge resolved something".

### P5 — Persona and key test behind the door; browser loses provider access

`POST /api/ai/generate/persona` (reasoning) replaces `generatePersonaCopy` (`persona.js:121-186`);
`testAiKey` (`persona.js:281-330`) delegates to `POST /api/ai/providers/:id/test`; delete the frontend provider
clients and `frontend/src/lib/aiProviders.js` (the "keep in sync" duplication,
`aiProviders.js:1-11`), fetching labels/defaults from `/api/ai/presets` instead.

- Tests: persona route (auth, rate limit, prompt isolation), Settings persona flow, and the
  `frontend-ai-boundary.test.js` hostname ban now green.
- Rollback: revert; the old browser path is self-contained and needs no server support.

**What P5 shipped, and where it deviated from this sketch.** The rewrite moved behind the door, the
browser lost every provider path, and the boundary is now a test on both sides. Deviations, recorded
here rather than in code comments:

- **The request is `{ user_role, ai_role, language, copy }` — the browser still supplies the base
  strings, as DATA.** The backend cannot own the copy: the UI must render it offline and before any
  call, so `frontend/src/i18n/locales/{en,id}.json` stays the one copy source and the route receives
  the slots it is asked to rewrite. What moved server-side is the PROMPT (the instruction text, the
  JSON data framing, the output shape) and the provider call. `copy` is a strict object of the nine
  `persona.*` slots: an unknown key is a 400, and `schemas.ts` ties its field list to
  `lib/persona.ts`'s `PERSONA_COPY_KEYS` at compile time (`satisfies Record<PersonaCopyKey, …>`), so
  a slot cannot be accepted and silently never rewritten. `language` selects the EN/ID prompt
  template because the copy the browser sends is already translated.
- **Prompt isolation is JSON framing, not an adjective.** Both inputs are user text, so the roles ride
  a `JSON.stringify` object and the copy a JSON object, under a sentence that names the blocks DATA and
  forbids following instructions inside them. A role containing quotes or newlines cannot close the
  block, and `prompt-isolation.test.ts` parses the block back to prove the payload is exactly the two
  role strings. The route test asserts the same on the wire.
- **`testAiKey` is DELETED, not rewritten as a delegate.** It had no caller after P3: the provider
  row's Test button already calls `POST /api/ai/providers/:id/test` through `useTestAiProvider`, and
  the old signature (`provider`, `aiKey`, `baseUrl`) has no meaning when the key never reaches the
  browser and the endpoint is a row id. A delegating wrapper would have been a dead export holding a
  second way to name a provider; the boundary test pins the retired route path instead.
- **The rate limit is the provider test's window (30/min per user), applied AFTER the 402 gate.** It is
  a burst guard on a billed call, not a budget cap: D9 still says no usage/token limit exists anywhere,
  and an unconfigured household keeps getting the honest 402 instead of a 429 that implies its request
  would otherwise run. The route answers 429 + `Retry-After`, like the OCR and provider-test limiters.
- **An unusable answer is a 502 that carries the bill.** Per-key fallback is preserved (a slot the
  model omits, empties, or bloats past 600 characters keeps the browser's own string — the rewrite is
  a flourish, never a way to blank the UI), but an answer that is not a JSON object at all is
  `AiError('invalid_response', …, {call, usage})`, so the route records the billed attempt (the P4 A1
  rule) and the UI shows the failure instead of silently pretending it rewrote nothing.
- **The 402 is not an error in Settings.** Apply saves the persona and then asks for the rewrite; a
  402 keeps the built-in copy, settles the button on "Saved", and shows no failure — the persona works
  without AI (plan §5.1 "not_configured is a normal state"). Only a real failure surfaces the error.
  `settings.personaInfo` (en + id) no longer says the rewrite is unavailable.
- **The boundary test lives at `frontend/src/lib/frontend-ai-boundary.test.js` and scans more than
  hostnames.** It bans a provider hostname, a `Bearer`/`x-api-key` header, a hardcoded absolute
  `fetch()` URL, and the retired `/api/ai-key/test` path across `frontend/src/**`, and asserts the
  deleted `lib/aiProviders.js` stays deleted; `*.test.js(x)` files are exempt because a fixture may
  name an endpoint the API returns (the Settings preset test does exactly that). `aiProviders.js` was
  already readerless after P3 — the screen learns labels and endpoints from `GET /api/ai/presets` — so
  P5 deleted the table and its test rather than rewiring it.

**Why this order:** enforcement before the move (P2's boundary test exists before P4 relocates five
call sites), data before behaviour (P1 before P4), and **screen and schema together** in P3 so a user
can always see and fix what the runtime resolves. The destructive drop no longer needs its own phase:
it rides with the screen that made the columns dead. That is what turns six phases into five and
removes the long tail this project used to carry.

---

## 7. Risks and resolved questions

Nothing in this section is waiting for an answer. §7.1 records what can still go wrong; §7.2 records
the owner's dispositions of the seven questions this document carried, each of which is now a line in
the design rather than a TODO.

### 7.1 Risks

1. **Subrequest budget.** The Workers free plan allows 50 subrequests per invocation and the review
   sweep budgets ~47 for 20 items (`review-ai.ts:60-66`). A per-item capability read would add 20
   reads and blow it. Mitigation is in the design: `resolveAccess` once per run, `AiAccessHandle`
   reused, no per-call DB reads. The household key is the same one join the user key was, and P2's
   lazy re-encrypt adds one write **once per legacy row**, not per call. P4's test pins "one
   capability read per sweep".
2. **Key blast radius.** Today one `encrypted_ai_key` per user; after this change, N per household, all
   under the same `WORKER_ENCRYPTION_KEY`. Rotating that key already invalidates every stored key
   (`docs/ARCHITECTURE.md:478`); now it invalidates N per household. The **transplant** half is closed
   by D10 (§3.6); the **rotation** half is unchanged by design — one key is still the blast radius that
   rotation exists for.
3. **Behaviour change disguised as a fix.** Receipt scan switching to the vision model (§5.5) can
   surprise a household whose text model was doing fine. Mitigation: release note, and the UI shows
   "Vision model" on the scan path; the vision assignment inherits the migrated `ai_vision_model`
   which, when unset, is the old text model — so nothing changes for households that never set it.
4. **No safety net, by design.** D8 removes the platform key, so a household that deletes a provider —
   or whose key stops decrypting — gets 402 and the feature degrades (review assist/auto → manual,
   chat unavailable) with nobody to bill but themselves. That is the intended trade, but it puts real
   weight on the empty state, on the 402 copy being actionable ("Add a provider in Settings"), and on
   `ai_status` telling the truth per capability. P3 tests the copy, P4 tests the degradation.
5. **Configuration blackout between P1 and P3 — the price of D6.** With no compatibility window, the
   old Settings screen writes **dead columns** from the moment the resolver swaps until P3 replaces it:
   a household can **use** AI (the backfill moved its rows) but cannot add, edit or re-key a provider,
   and a member cannot fix a broken key. The owner accepted the breakage; the mitigation is release
   discipline rather than code — P1+P2+P3 ship to the QA deployment as **one release**, the release
   note says so, and the three automation AI scenarios are pending until P3. If the phases ever slip
   apart, the fix is to ship them together, never to re-introduce a write-through.
6. **Typed-decision answers are thin — accepted by D3.** Choice + confidence only: no reason, no
   tokens. Consequences: `review_ai_verdicts.reason` is empty under a `questions` provider, and the
   admin breakdown renders those calls as "typed — not token-billed" rather than a zero (§7.2). Both
   are visible, not hidden.
7. **Sharing changes who pays.** D1 moves ownership from the person to the household, and the backfill
   cannot guess intent: in a two-member household where both had keys, the **owner's** assignment wins
   and the other member's calls now run on the owner's key (their own key survives as an unassigned
   provider row). This is the largest real-world discontinuity in the design, and it is deliberate.
   Mitigations: every row says whose key served the call (`user_id` + `household_id`), the Settings UI
   names the owner, the release note calls it out, and an owner can re-point the assignment in two
   clicks. The member-side consequence is equally real: a member cannot fix a broken key — only an
   owner can, so the UI must say so instead of offering a control that 403s.

### 7.2 Resolved questions (owner, 2026-11-07)

| #   | Question                     | Decision                                                                                                                                                                                                                                                                | Where it lives |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Embeddings now or later?     | **Later.** No fourth capability in v1; `embedding` is an additive enum value when a feature needs it.                                                                                                                                                                   | D5, §2.4       |
| 2   | Typed-provider token counts  | **Accept zeros**, marked `provider = 'questions'`. The admin breakdown shows "typed — not token-billed" instead of a misleading `0`. No counter in v1.                                                                                                                  | §5.3           |
| 3   | Local/private endpoints      | **HTTPS-only stands.** No private-network HTTP, and no `TEST_MODE` exception to the rule.                                                                                                                                                                               | §4.2           |
| 4   | Legacy column drop           | **No compatibility window.** P6 is deleted; the six `user_settings.ai_*` columns are dropped in **P3**, with the new Settings screen and the old `PATCH` handling. P1 leaves the columns untouched and adds no write-through.                                           | D6, §4.3, P3   |
| 5   | Chat provider for `decision` | **Both allowed.** A JSON-mode chat provider may answer the verdict; the typed provider is the other option, not the only one.                                                                                                                                           | §2.4, §4.2     |
| 6   | Provider test cost           | **Free probe**: an empty `questions` object, expecting a 400 that proves authentication with no billing — **pending Jev's confirmation**. If Jev 500s or bills on an empty body, the fallback is the billed micro-question. A `MANUAL_ACTIONS` verification item in P3. | §4.6, P3       |
| 7   | Premium metering             | **Shape only**: `funding`, facade-only metering, reserved `quota_exceeded`. Quota numbers and plans are designed with the premium feature, not before it exists.                                                                                                        | D9, §2.6       |

---

## 8. References

- Issue: `ahaqqu/RumaQ#523`; owner directive quoted in the issue body.
- `backend/src/lib/ai.ts`, `ai-access.ts`, `chat.ts`, `plans.ts`, `review-ai.ts`, `document-ocr.ts`.
- `backend/src/lib/households.ts` (`HouseholdRole`, `requireOwner`), `backend/src/auth.ts:136-145`
  (`ACTIVE_HOUSEHOLD_SQL`), `backend/migrations/0001_schema.sql:17-31` (`households`,
  `household_members` roles).
- Migrations `0001`, `0008`, `0009`, `0015`, `0033`, `0038`.
- `docs/ARCHITECTURE.md` §7 (AI integration), §9 (env table).
- `docs/plan/plugin-architecture.md` §4.2 (port/adapter precedent), §7 (phase-as-PR style).
- `RumaQ-pipeline/groceries/scraper/src/categorize/jev.ts` (the typed-decision wire, for reference
  only — no code is shared).
