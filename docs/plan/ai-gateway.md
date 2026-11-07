# AI gateway — one door, capability-routed providers

> Status: **proposed; awaiting owner sign-off.** Design only — no product code in this PR.
> Issue: `ahaqqu/RumaQ#523`. Owner directive: 2026-11-07 ("AI is the core of RumaQ — every
> feature routes through one door").
>
> Reviewed against `origin/main` @ `30ea632`.

## 0. Decision summary

The nine decisions this document rests on. **Three of them were taken by the owner on 2026-11-07**
(D2, D3, D8) and are no longer open; the rest need sign-off with the document.

| #   | Decision             | Choice                                                                                                                                                                                                                                                                                                      |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Data model           | New `ai_providers` + `ai_capabilities` tables. `user_settings.ai_*` columns stay for one release as a compatibility projection, then drop.                                                                                                                                                                  |
| D2  | Provider abstraction | **Owner-decided 2026-11-07.** Four **wire-protocol** adapters — `openai-compatible` (OpenAI, Ollama, OpenCode, custom base URL), `anthropic`, `gemini`, `questions` — behind one interface. The six vendor presets are data rows (label + base URL + default models), never classes.                        |
| D3  | Decision wire        | **Owner-decided 2026-11-07.** The `questions` adapter speaks a typed question/answer contract: `POST {base}` with `{state, model, questions:{<name>:{type,instructions,criteria}}}` → `answers.<name>.{choice, confidence}`. Reason-as-NULL and zero reported tokens are accepted limitations.              |
| D4  | The door             | `backend/src/lib/ai/` (barrel `index.ts`). Outside `lib/ai/**` no file may import an adapter, hold an API key, or contain a provider hostname — enforced by a test.                                                                                                                                         |
| D5  | Capability enum      | `decision` \| `reasoning` \| `vision`. Additive; `embedding` is explicitly out of scope.                                                                                                                                                                                                                    |
| D6  | Migration            | Backfill is **behaviour-preserving**: every configured user's one provider becomes provider #1 and is assigned to all three capabilities with today's model values. Never a forced rewrite of a working setup.                                                                                              |
| D7  | Empty start          | **No per-user default provider.** A new account has zero `ai_providers`, zero `ai_capabilities`, no implicit model — and therefore today's exact "not configured" behaviour (402, review assist/auto → manual, no calls) until the user adds a provider and assigns capabilities. No preset is preselected. |
| D8  | No server fallback   | **Owner-decided 2026-11-07.** `RUMAQ_SERVER_AI_*` is retired: no env key, no implicit provider, no platform-funded call. Resolution is the caller's assignment → 402. QA/testing accounts get ordinary rows through Settings; automation seeds the same rows in its setup step (§3.4).                      |
| D9  | Rollout              | Six independently shippable PRs (P1–P6). P1 is schema + resolver swap. The destructive column drop is its own PR (P6).                                                                                                                                                                                      |

D2 is the one place this document refines the directive's literal wording. The directive listed five
adapter names ("OpenAI-compatible, Anthropic, Gemini, Ollama, custom base URL"); the owner confirmed
that three of them are one wire protocol with different base URLs. Collapsing them is what makes "one
interface" true instead of decorative, and it is what lets the typed-decision adapter (D3) sit beside
chat adapters without a special case.

The other open questions are in §7; nothing in §1–§6 depends on them.

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

## 2. Target architecture

### 2.1 Module layout

```
backend/src/lib/ai/
  index.ts            ← THE DOOR. The only AI import allowed outside lib/ai/**.
  types.ts            ← Capability, AiMessage, AiCall, AiResult, ThinkingLevel, TokenUsage
  errors.ts           ← AiError + code→HTTP mapping
  capabilities.ts     ← resolveAccess(ctx, capability), the precedence ladder
  credentials.ts      ← provider rows ←→ env fallback; decrypt; NO other module may import this
  presets.ts          ← the vendor catalog as DATA (label, kind, base URL, default models)
  usage.ts            ← buildAiUsageEventStatement / recordAiUsageEvent / retention (moved)
  decision.ts         ← the {choice, confidence} parse shared by chat-shaped decision calls
  adapters/
    types.ts          ← AiAdapter interface
    openai.ts         ← chat-completions wire (OpenAI, OpenCode, Ollama, custom base URL)
    anthropic.ts      ← Messages API wire
    gemini.ts         ← generateContent wire
    questions.ts      ← typed question/answer wire (one decision question in, one choice out)
    registry.ts       ← kind → adapter; the ONLY switch on kind
```

`backend/src/lib/ai.ts` becomes a **deprecated shim** in P2 (same exports, delegating to the door) so
the adapters land without touching a single feature, and it is **deleted** in P4 when the call sites
move (imports become `lib/ai/index.js`, explicit `index.js` per the `ports/storage/index.js`
precedent). The old `ai-access.ts` dissolves in P2–P4: resolution → `capabilities.ts`, usage →
`usage.ts`, the projection constant stays with the settings read model until P6.

### 2.2 The public API

Everything a feature needs, and nothing else. No `apiKey` ever appears in a signature.

```ts
// backend/src/lib/ai/index.ts

export type Capability = 'decision' | 'reasoning' | 'vision'
export type ThinkingLevel = 'low' | 'medium' | 'high'

/** What a provider call costs/attributed to. Carried on success AND failure. */
export type AiCall = {
  capability: Capability
  providerKind: ProviderKind // 'openai-compatible' | 'anthropic' | 'gemini' | 'questions'
  providerId: string // always a user-owned row; there is no server fallback (D8)
  model: string | null // null = the adapter's default for this capability
  keySource: 'user' // historical usage rows may still say 'server'; nothing writes it now
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

export type AiCtx = { env: Env['Bindings']; userId: string | null }

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

/** Resolve once. null = this capability is not configured (routes answer 402). */
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

/** Usage accounting, beside the door so call sites never hand-build SQL. */
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
  `from '.*ai/adapters`, `api.anthropic.com|generativelanguage.googleapis.com|api.openai.com|ollama.com|api.opencode.ai|api.typesafe.ai`, and on `\.apiKey\b`.
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
  /** The model used when the assignment leaves model NULL (today's hardcoded defaults). */
  defaultModel(capability: Capability): string | null
  /** Chat-shaped call: one request, one text answer, one usage report. */
  complete(req: AdapterRequest): Promise<AdapterResult>
  /** Closed-choice decision. Chat adapters do prompt + strict JSON parse. */
  decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult>
  /** Schema-constrained JSON decision. Absent on providers that only answer choices. */
  structured?(req: AdapterRequest): Promise<AdapterResult>
}

export type AdapterRequest = {
  capability: Capability
  model: string | null
  messages: AiMessage[]
  json: boolean
  thinkingLevel: ThinkingLevel | null
  maxTokens?: number
  baseUrl: string | null
  apiKey: string
  signal: AbortSignal
}
```

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

---

## 3. Data model

### 3.1 Decision: new tables (D1)

Rejected alternatives, briefly:

- **Extend `user_settings` with `ai_decision_model` only.** Cheapest migration, but cannot express
  "decision → Jev, reasoning → Claude": one `ai_provider` column means one key, one base URL, one
  vendor. It also makes the owner's core ask ("multiple providers at once") unrepresentable.
- **A JSON blob column (`ai_config`).** No uniqueness, no FK, no per-row delete semantics, and every
  read becomes an app-side parse. Also unqueryable for the admin usage views.
- **`ai_providers` only, with capability assignments inside the provider row.** Then "reasoning and
  vision on one provider, decision on another" works, but the capability becomes a column triple in
  one table (`decision_model`, `vision_model`…) and the unique-per-capability invariant has no home.

Two tables, because they are two different nouns: a **provider** (credentials + wire + endpoint)
and a **capability assignment** (which provider, which model, which thinking level, for what).
The unique key on `ai_capabilities` is then literally the directive: one row per capability.

### 3.2 DDL sketch — `backend/migrations/0039_ai_gateway.sql`

```sql
-- AI gateway (ahaqqu/RumaQ#523): multiple providers per user, one assignment per
-- capability (decision / reasoning / vision), and a capability stamp on usage rows.
-- NUMBERING: 0038 is applied (review_ai); this takes the next free slot. Never
-- rename an applied migration — wrangler keys d1_migrations by filename.

-- A provider instance: the wire kind, a preset, an optional base URL, one sealed key.
-- A typed-decision endpoint is a row like any other — a label, kind 'questions',
-- and a base URL. No vendor name appears in a table, column, or type: the
-- abstraction is the wire, and nothing is seeded per user.
CREATE TABLE IF NOT EXISTS ai_providers (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note (on rowid tables a
  -- TEXT PRIMARY KEY does not imply NOT NULL). The 0039 backfill writes
  -- 'legacy-' || user_id so the migration can address the row deterministically.
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The user's own name for it ("Work account", "Personal key").
  label TEXT NOT NULL,
  -- The WIRE protocol, not the vendor: 'openai-compatible' serves OpenAI, OpenCode,
  -- Ollama and any custom base URL — see presets.ts. 'gemini' is separate because
  -- its wire is genuinely different; 'questions' is a typed choice/answer wire.
  kind TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic', 'gemini', 'questions')),
  -- The vendor preset this row was created from ('openai', 'opencode', 'ollama',
  -- 'custom', 'anthropic', 'gemini', or NULL for a hand-configured
  -- endpoint). DATA, not a type: a new vendor is a row in presets.ts, never a
  -- migration and never a new kind. The preset supplies the display label, the
  -- canonical base URL and the default models per capability.
  preset TEXT,
  -- Optional: NULL = the preset's canonical endpoint. Required when there is
  -- neither a preset endpoint nor this value ('custom', 'questions').
  base_url TEXT,
  -- AES-GCM ciphertext (lib/crypto.ts). NULL means the row cannot serve a call:
  -- it may be edited and re-keyed, but it cannot be ASSIGNED to a capability
  -- until it has a key. NEVER returned by an API.
  encrypted_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- If a key is stored it must be a crypto.ts envelope, not a plaintext slip.
  CHECK (encrypted_key IS NULL OR encrypted_key LIKE 'v1:%')
);

-- Case-insensitive per-user label uniqueness: two "Gemini" rows are a UX bug,
-- not a feature. Expression index, so the check is the database's, not the route's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_user_label
  ON ai_providers (user_id, lower(label));

-- Exactly one assignment per (user, capability) — the PK IS the invariant.
CREATE TABLE IF NOT EXISTS ai_capabilities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('decision', 'reasoning', 'vision')),
  -- Deleting a provider clears the assignments that pointed at it (CASCADE):
  -- the capability then becomes not configured (402). The API
  -- reports the cleared capabilities so the UI can warn BEFORE the delete.
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  -- NULL = the adapter's default model for this capability (today's behaviour).
  model TEXT,
  -- Per-capability thinking level: NULL = the provider default.
  thinking_level TEXT CHECK (thinking_level IN ('low', 'medium', 'high')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, capability),
  -- Vision and typed-decision providers take no reasoning knob: a vision OCR read
  -- wants a cheap deterministic answer, and a questions endpoint has no such field.
  -- Enforced here so no adapter has to silently drop it.
  CHECK (capability <> 'vision' OR thinking_level IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_ai_capabilities_provider ON ai_capabilities (provider_id);

-- Usage rows gain the capability dimension. NULL on rows written before 0039
-- (they are still valid history; the admin views treat NULL as "unknown").
ALTER TABLE ai_usage_events ADD COLUMN capability TEXT;

-- Capability-scoped "today" and per-capability admin breakdowns.
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_date_capability
  ON ai_usage_events (user_id, date, capability);
```

Deliberately **not** modelled: a `default_provider` flag (the capability assignments say what is
used), an `is_active` flag (delete is the off switch), and any secret material outside
`encrypted_key` (the existing `crypto.ts` helpers handle it, and the v1: envelope keeps rotation
possible).

Both SQL blocks below were executed against `node:sqlite` (the engine class `migrations.test.ts`
already uses) on a 0015/0033-shaped schema before this document was published: the backfill row set,
the `ON DELETE CASCADE` behaviour, and the kind / label / vision-thinking CHECKs all behave as
described here. P1 turns that ad-hoc check into the committed migration test.

### 3.3 Migration from today's single provider

```sql
-- 1) One provider per configured user. A user with no key is not migrated: there
--    is nothing to preserve, and a keyless provider row would render as broken.
INSERT INTO ai_providers (id, user_id, label, kind, preset, base_url, encrypted_key)
SELECT 'legacy-' || user_id,
       user_id,
       CASE ai_provider
         WHEN 'openai' THEN 'OpenAI'
         WHEN 'opencode' THEN 'OpenCode'
         WHEN 'anthropic' THEN 'Anthropic'
         WHEN 'gemini' THEN 'Gemini'
         WHEN 'ollama' THEN 'Ollama Cloud'
         ELSE 'Custom provider'
       END || ' (imported)',   -- the label tells the user where it came from
       CASE ai_provider WHEN 'anthropic' THEN 'anthropic'
                        WHEN 'gemini' THEN 'gemini'
                        ELSE 'openai-compatible' END,
       ai_provider,          -- the legacy value IS a preset id (0008 vocabulary)
       ai_base_url,
       encrypted_ai_key
  FROM user_settings
 WHERE ai_provider IS NOT NULL
   AND encrypted_ai_key IS NOT NULL AND encrypted_ai_key <> ''
   AND encrypted_ai_key LIKE 'v1:%';

-- 2) All three capabilities inherit today's behaviour EXACTLY:
--    reasoning = ai_model + ai_thinking_level
--    vision    = COALESCE(ai_vision_model, ai_model)   (0033's precedence, ai-access.ts:108)
--    decision  = ai_model + ai_thinking_level          (review already runs on these)
INSERT INTO ai_capabilities (user_id, capability, provider_id, model, thinking_level)
SELECT user_id, 'reasoning', 'legacy-' || user_id, ai_model, ai_thinking_level
  FROM user_settings
 WHERE ai_provider IS NOT NULL
   AND encrypted_ai_key IS NOT NULL AND encrypted_ai_key <> ''
   AND encrypted_ai_key LIKE 'v1:%';
INSERT INTO ai_capabilities (user_id, capability, provider_id, model, thinking_level)
SELECT user_id, 'vision', 'legacy-' || user_id, COALESCE(ai_vision_model, ai_model), NULL
  FROM user_settings
 WHERE ai_provider IS NOT NULL
   AND encrypted_ai_key IS NOT NULL AND encrypted_ai_key <> ''
   AND encrypted_ai_key LIKE 'v1:%';
INSERT INTO ai_capabilities (user_id, capability, provider_id, model, thinking_level)
SELECT user_id, 'decision', 'legacy-' || user_id, ai_model, ai_thinking_level
  FROM user_settings
 WHERE ai_provider IS NOT NULL
   AND encrypted_ai_key IS NOT NULL AND encrypted_ai_key <> ''
   AND encrypted_ai_key LIKE 'v1:%';
```

Notes the implementation must honour:

- A legacy `ai_provider = 'custom'` row with **no** `ai_base_url` is migrated as-is and stays broken
  in exactly the same way (the old dispatcher threw at call time, `ai.ts:506-511`). It must **not**
  silently become an OpenAI call: `preset = 'custom'` has no canonical endpoint, so the row resolves as
  unusable (log line, not configured → 402) and the Settings screen flags it "needs a base URL".
- The capability INSERTs repeat `ai_provider IS NOT NULL` on purpose: a user can hold a key with no
  provider chosen (`PATCH /api/settings` accepts `ai_key` alone), and such a row has no
  `legacy-…` provider to reference — the FK would abort the whole migration.
- All four statements filter `encrypted_ai_key LIKE 'v1:%'` for the same reason: one hand-edited
  non-envelope ciphertext would fail the `ai_providers.encrypted_key` CHECK and abort the entire
  migration. Such a row is skipped (its key could never be decrypted anyway) and the user lands in
  the normal "not configured" state instead of blocking everyone else's deploy.
- `thinking_level` for `vision` is forced NULL: 0033 never had one, and the CHECK above requires it.
- The migration is **idempotent only in the sense of not re-running**: wrangler tracks filenames, and
  the legacy ids are deterministic. A re-run on a migrated DB would violate the provider PK — that is
  the intended loud failure, not silent duplication.
- `ai_model`-less users (provider + key, no model) migrate with `model = NULL` = adapter default —
  identical to today.

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
`PUT /api/ai/capabilities/{decision,reasoning,vision}`); the legacy `PATCH /api/settings`
write-through (§4.3) keeps today's scenarios green until P6. `TEST_MODE` still stubs the transport,
so seeded rows exercise the **resolver** without a real provider call — which is exactly why the rows
must exist. The "no AI key returns 402" scenarios stay honest by seeding nothing.

**Key provenance.** `ai_usage_events.key_source` keeps its column and its history, but new rows are
always `'user'`. Nothing in the product can spend a platform key any more, so the admin views no
longer need to distinguish a platform-paid call.

### 3.5 Uniqueness, deletion, ownership

| Rule                                     | Where                                                | Behaviour                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| One assignment per capability            | `PRIMARY KEY (user_id, capability)`                  | `PUT /api/ai/capabilities/:capability` is an upsert                                                                      |
| Labels unique per user, case-insensitive | `idx_ai_providers_user_label`                        | 409 on create/rename                                                                                                     |
| Deleting a provider                      | `ON DELETE CASCADE` on `ai_capabilities.provider_id` | the capability becomes not configured → 402; DELETE response reports `{ cleared: ['reasoning'] }`; the UI confirms first |
| Deleting a user                          | `ON DELETE CASCADE` from `users` on both tables      | no orphans                                                                                                               |
| Usage rows survive provider edits        | no FK from `ai_usage_events`                         | history stays readable after a provider is deleted (it stores kind + model + capability, not provider id)                |
| Ownership                                | `ai_providers.user_id`                               | per-user for v1; household-shared keys are OQ1                                                                           |

`ai_usage_events` stores the **kind** in `provider` (as today) plus `capability`; it does not store
`provider_id`, because a deleted provider must not orphan or rewrite history.

---

## 4. Settings API + UI

### 4.1 Endpoints

All authenticated and registered in the existing `apiApp.use(..., propsAuthMiddleware)` block
(`apps/api.ts:621-669`) — a missed entry is an unauthenticated route, so the phase test asserts
each new path 401s without a session.

| Method        | Path                               | Purpose                                                                                                                                                                                                             |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`         | `/api/ai/presets`                  | The catalog of presets a user MAY add: id, label, kind, canonical base URL, default models per capability. Seeds nothing, preselects nothing, and defines no default. **The one place the UI learns vendors from.** |
| `GET`         | `/api/ai/providers`                | `{ providers: [{ id, label, kind, base_url, has_key, created_at, updated_at }] }` — never the key                                                                                                                   |
| `POST`        | `/api/ai/providers`                | Create `{ label, kind, base_url?, api_key, preset? }` → 201 with the row                                                                                                                                            |
| `PATCH`       | `/api/ai/providers/:id`            | Update `{ label?, kind?, base_url?, api_key? }`; `api_key: ''` clears it, omitted leaves it                                                                                                                         |
| `DELETE`      | `/api/ai/providers/:id`            | Delete + cascade; returns `{ cleared: Capability[] }`                                                                                                                                                               |
| `POST`        | `/api/ai/providers/:id/test`       | Test connection (see §4.6). Body `{}`; rate-limited                                                                                                                                                                 |
| `GET`         | `/api/ai/capabilities`             | `{ capabilities: { decision: { provider_id, model, thinking_level, source: 'user'\|'none', provider_label } , … } }`                                                                                                |
| `PUT`         | `/api/ai/capabilities/:capability` | Upsert `{ provider_id, model?, thinking_level? }`                                                                                                                                                                   |
| `DELETE`      | `/api/ai/capabilities/:capability` | Clear the assignment (the capability becomes not configured)                                                                                                                                                        |
| `GET`         | `/api/ai/usage`                    | Existing (`api.ts:1439`) + per-capability breakdown for today                                                                                                                                                       |
| `GET`         | `/api/admin/ai/usage`              | Existing (`api.ts:1523`) + per-capability totals                                                                                                                                                                    |
| `GET`/`PATCH` | `/api/settings`                    | Unchanged shape + additive `ai_providers`, `ai_capabilities`, `ai_status { decision, reasoning, vision: 'user'\|'none' }`; `server_ai_available` is **removed** in P3 (D8)                                          |

Deprecated but kept until P6: `POST /api/ai-key/test` (`api.ts:1298`), superseded by
`/api/ai/providers/:id/test`.

### 4.2 Validation

Valibot schemas in `backend/src/schemas.ts` beside the existing `settingsPatchSchema:26`:

- `kind` — `picklist(['openai-compatible', 'anthropic', 'gemini', 'questions'])`.
- `label` — `pipe(string(), minLength(1), maxLength(60))`, trimmed; unique per user (409).
- `base_url` — `maxLength(500)`, trimmed, trailing slashes stripped, **HTTPS only** (the existing
  rule, `api.ts:1198-1200`), required when `kind = 'questions'` or when no canonical endpoint
  exists for the kind. HTTP / private-network endpoints are OQ5.
- `api_key` — `minLength(1)` on create, trimmed, encrypted with `encryptAiKey` (`crypto.ts:85`)
  before the INSERT; never echoed, never logged; `has_key` is the only signal the API returns.
- **An assignment requires a usable provider**: the target row must have an `encrypted_key` and a
  resolvable endpoint (its own `base_url` or its preset's). Clearing a key on an assigned provider is
  a 409, not a silent downgrade ("this provider is used by reasoning — reassign first").
- `model` — the existing `AI_MODEL_REGEX` (`schemas.ts:24`) and 200-char cap. It is load-bearing:
  Gemini interpolates the model into the URL path (`ai.ts:312-315`).
- `thinking_level` — `low|medium|high|''`; rejected (400) for `vision` and for `kind = 'questions'`.
- **Cross-field checks** (server-side, not just UI): provider kind must `supports(capability)`; a
  capability assignment must reference a provider owned by the caller (`WHERE id = ? AND user_id = ?`,
  so a leaked id is a 404, not another user's provider).
- **There is no implicit assignment.** `PUT /api/ai/capabilities/:capability` is a 404 when the caller
  has no provider with that id, and nothing creates a provider or an assignment on the user's behalf —
  not the migration, not the UI, not the first AI request.

### 4.3 Legacy compatibility window

`GET/PATCH /api/settings` keep their AI fields for one release, because the PWA and mobile wrappers
update on their own schedule. **The write-through lands in P1, with the resolver swap** — that is
what keeps the _existing_ Settings screen able to configure AI while the new UI is still being built,
and it is how the QA accounts get their rows (§3.4). P3 adds the new endpoints; P6 removes the legacy
fields.

- **Read-through**: `ai_provider` / `ai_model` / `ai_vision_model` / `ai_thinking_level` are derived
  from the new tables (reasoning assignment → provider kind/base URL/model; vision model; reasoning
  thinking level). `has_ai_key` = any provider row has a key.
- **Write-through**: a legacy `PATCH` updates the migration-shaped provider and the three
  assignments, so an old client can never desynchronise the new model. `ai_key` writes to that
  provider's `encrypted_key`.
- P6 drops the columns, the shim, and this window (OQ6 is the timing decision).

### 4.4 Screen structure — Settings → AI

One section. **Two states, and the empty state comes first.**

**State A — no provider yet** (`providers.length === 0`), for every new account:

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
     Provider `<select>` listing only the user's providers (nothing preselected; the first option is
     "Choose a provider") — **no "use server default" option exists** (D8); model input whose
     placeholder is the adapter's default; thinking select (hidden when the provider has none).
   - **Reasoning model** — "Chat and shopping plans." Same shape.
   - **Vision model** — "Reading receipts and documents." No thinking select.
     Each card renders its resolved source as a status line: _"Using <label>"_ or _"Not
     configured"_. There is no third state.
3. **Providers** — list rows (label, kind, base URL, key state) with **Test**, **Edit**, **Delete**;
   the **Add provider** form (preset picker, nothing preselected; advanced: kind + base URL + model
   for a typed-decision endpoint). Deleting a provider that is assigned shows which capabilities will
   become **not configured** before the confirm.
4. **Usage** — today's calls/tokens, broken down by capability.

The legacy provider/model/thinking inputs (`Settings.jsx:351-437`) are removed in P3; nothing in the
UI reads `ai_model` after that.

### 4.5 Copy and defaults

- **No vendor is a default.** `presets.ts` carries only the catalog a user may choose from (the six
  presets that exist today: OpenAI, OpenCode, Anthropic, Gemini, Ollama, custom). There is no seeded
  provider, no preselected preset, and no copy that implies one. A typed-decision endpoint is
  configured through the advanced form — kind `questions` + base URL + model — and this document
  mentions "Jev" only as the owner's concrete example of such an endpoint, never as a preset id.
- The **only** default the UI offers is per chosen provider: leaving the model input empty means
  "this provider's default model", resolved by the adapter's `defaultModel(capability)`
  (`gpt-4o-mini`, `gemini-3.6-flash`, `claude-3-haiku-20240307`, `glm-5.3-flash` today). That is a
  model default inside a provider the user picked, not a provider default.
- i18n: new keys under `settings.ai.*` in `frontend/src/i18n/locales/{en,id}.json`, both languages in
  the same PR (the `visionModelDesc` precedent at `en.json:587`).

### 4.6 What "test connection" means per kind

| kind                | Request                                                         | Cost                                                                                                                  |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `openai-compatible` | `GET {base}/models` with the decrypted key                      | free                                                                                                                  |
| `anthropic`         | `GET https://api.anthropic.com/v1/models` + `anthropic-version` | free                                                                                                                  |
| `gemini`            | `GET /v1/models?key=…`                                          | free                                                                                                                  |
| `questions`         | one minimal question over the assigned model                    | **billable** — labelled as such in the UI, rate-limited (the OCR limiter precedent, `plugins/documents/ocr.ts:46-54`) |

The test never uses a stored provider's key for a _different_ provider, and the response is
`{ ok: true }` / `{ ok: false, code }` — never the provider body verbatim (it can echo key material
in error messages).

---

## 5. Runtime

### 5.1 Resolution precedence

```
resolveAccess(ctx, capability):
  if ctx.userId:
    row = SELECT c.model, c.thinking_level,
                 p.id, p.kind, p.preset, p.base_url, p.encrypted_key
            FROM ai_capabilities c JOIN ai_providers p ON p.id = c.provider_id
           WHERE c.user_id = ? AND c.capability = ?          -- 1 subrequest, 1 join

    if row and row.encrypted_key:                            -- no key: row is unusable
      baseUrl = row.base_url ?? presetEndpoint(row.preset)   -- presets.ts, null for 'custom'
      if baseUrl or row.kind != 'questions':                 -- questions has no canonical endpoint
        try:   key = decryptAiKey(row.encrypted_key, WORKER_ENCRYPTION_KEY)
        catch: log '[ai] stored provider unusable user=…'    -- never 500
        else:  return handle(user)                           -- model NULL = adapter default
    else:
      log '[ai] capability assignment has no usable provider user=…'   -- Settings flags it

  return null                                                -- routes answer 402
```

There is no server branch (D8): an unconfigured capability is unconfigured, and the ladder above is
the whole ladder.

Rules that make this honest:

- **The user's own rows are the only source.** There is no env key, no shared provider, and no
  "platform default" to fall back to (D8). The only default in the system is the adapter's model
  default _within_ a provider the user chose.
- **A broken stored key is not a 500.** An undecryptable ciphertext or an unusable row (missing key,
  no resolvable endpoint) is logged, treated as not configured, and shown as "needs setup" in
  Settings — the same 402 the user would get with nothing configured, instead of today's
  inconsistency where chat/scan throw 500 on an undecryptable key.
- **`not_configured` is a normal state**, not an error: the review layer keeps degrading assist/auto
  to manual (`review-ai.ts:727-740`), routes keep 402.
- **Empty means empty.** A new account has no rows for any capability, so `resolveAccess` returns
  `null` for every capability. No code path invents a provider, a model, or a vendor.

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

| code               | cause                                                         | HTTP | note                                                                                                    |
| ------------------ | ------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| `not_configured`   | no assignment for the capability, or its provider is unusable | 402  | unchanged route strings                                                                                 |
| `unsupported`      | kind cannot serve the capability                              | 500  | should be unreachable: save-time validation                                                             |
| `auth`             | provider 401/403                                              | 502  | body truncated, key never echoed                                                                        |
| `rate_limited`     | provider 429                                                  | 502  | `Retry-After` surfaced on the error, not re-sent as a retry                                             |
| `timeout`          | our `AbortSignal` fired                                       | 502  | **same status as today** so client handling is unchanged; `code` carries the distinction                |
| `provider_error`   | other 4xx/5xx                                                 | 502  | message keeps the provider label (`"Gemini request failed: 500 …"`) so existing route tests stay honest |
| `invalid_response` | empty content, unparseable JSON, off-schema decision          | 502  | feature-level validation still runs after and can reject further                                        |

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
  (id, user_id, ts, date, provider, model, capability, input_tokens, output_tokens, cached_tokens, key_source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

- `provider` = the **kind** (`'openai-compatible'`, `'questions'`) — continues today's meaning.
- `model` = the model actually sent; NULL = adapter default.
- `capability` = the dimension the directive asks for.
- `key_source` = `'user'` on every new row; the column and its historical `'server'` values stay for
  continuity (D8 retired the fallback).
- The sweep keeps its single batched write (`review-ai.ts:650-662`); `document-ocr.ts` keeps its
  "audit every attempt" pairing (`:121-136`), now reading `err.call`/`err.usage` from `AiError`.
- **Known gap**: the typed-decision wire reports no token counts. Such calls record
  `input_tokens = 0, output_tokens = 0, cached_tokens = NULL` and are distinguishable by
  `provider = 'questions'`; per-call billing analytics for that kind are approximate (OQ4).

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

Each phase is one PR, shippable alone, with its own rollback. Every phase runs
`./scripts/test.sh unit backend` (plus `frontend` where touched), `./scripts/style.sh --check`, and —
when routes change — `./scripts/docs.sh` and `bunx vp run api:codegen` (CI diffs both artifacts,
`scripts/github/ci.sh:16-24`).

### P1 — Schema, resolver swap, server-fallback removal

**The first PR, exactly:**

1. `backend/migrations/0039_ai_gateway.sql` — the two tables, indexes, CHECKs, backfill, and
   `ai_usage_events.capability` (§3.2–§3.3).
2. `backend/src/lib/ai/{types,presets,credentials,capabilities,usage}.ts` — `resolveAccess` on the
   **new** tables with the **two-outcome ladder** (assignment → null); `buildAiUsageEventStatement`/
   `recordAiUsageEvent`/`deleteExpiredAiUsageEvents` moved here, with the `capability` column.
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
5. `GET /api/settings` gains additive `ai_providers`, `ai_capabilities`, `ai_status`, and the legacy
   `PATCH` gains the **write-through** (§4.3): it upserts the migration-shaped provider and the three
   capability assignments from `ai_key` / `ai_provider` / `ai_model` / `ai_vision_model` /
   `ai_thinking_level`, so the current Settings screen keeps working and can seed the QA accounts.
6. Tests: `migrations.test.ts` (apply the chain in real SQLite; assert backfill row counts, the
   vision precedence, the case-insensitive label index, the CASCADE, the vision/thinking CHECK, and
   that a user with no legacy AI settings gets **zero** provider and capability rows);
   `ai-access.test.ts` **rewritten** as the two-outcome matrix — assignment → row, undecryptable key →
   null, missing/unusable provider → null, empty account → null, and "env vars present but ignored";
   the four suites that constructed the fallback (`documents-ocr`, `api-routes`, `review-ai`, plus
   `__tests__/support/env.ts`) seed provider + capability rows instead; `api-routes.test.ts` asserts
   the settings payload with `ai_status` all `none` for a fresh user; a route test that a legacy
   `PATCH /api/settings` creates the provider + three assignments (idempotently, on repeat patches).

**Not in P1:** no new endpoints, no new UI, no call-site edits, no adapter extraction, no deletion.
**Rollback:** revert the PR. The migration is additive (old code ignores the tables and the extra
column), the write-through wrote the legacy columns too, and the env fallback returns with the
reverted code — so QA keeps working either way. The QA rows themselves are configured once through
the existing Settings screen during this PR's verification (a `docs/MANUAL_ACTIONS.md` step): the
owner adds the `questions` provider for decision and the chat provider for reasoning/vision.

### P2 — The door: facade + protocol adapters

Move all provider transport into `lib/ai/adapters/*` behind `AiAdapter`; introduce
`lib/ai/index.ts` with `resolveAccess`/`completeText`/`vision`/`decide` and the `AiAccessHandle`
(module-private key). `lib/ai.ts` becomes a thin deprecated shim delegating to the door so the PR
lands without touching features; delete the shim in P4.

- Tests: an adapter contract suite driven by a fake `fetch` (one table of cases × 4 kinds: happy path,
  auth error, 429, 5xx, empty content, timeout via an aborted signal, usage mapping); the
  `decide()` shape across chat kinds vs the typed kind; `ai-boundary.test.ts` (the import/hostname
  rule) with an allow-list of exactly `lib/ai/**`.
- Rollback: revert; the shim and the old dispatcher come back, no schema change.

### P3 — Settings API + UI (first user-visible PR)

The `/api/ai/providers`, `/api/ai/capabilities`, `/api/ai/presets` endpoints, the provider test
endpoint, and the Settings screen rebuild (§4.4) with en+id copy. The legacy write-through from P1
stays in place and keeps being tested; P6 removes it with the columns. `server_ai_available` leaves
the `/api/settings` payload here, together with the "use server default" option that read it
(`api.ts:1114`, `Settings.jsx:487-500`), and the QA accounts' rows from P1 render as ordinary
providers.

- Tests: route tests for CRUD, 401 without a session, 404 on another user's provider id, 409 on a
  duplicate label, 400 on kind/capability mismatch, 400 on `vision` + thinking, 404 assigning a
  provider that does not exist, cascade reporting on delete; `Settings.test.jsx` for the **empty
  state** (no capability selectors until a provider exists, nothing preselected), the three
  capability cards, add/delete provider, "becomes not configured" warning, and the absence of any
  server-default affordance; the automation setup step moves to `POST /api/ai/providers` +
  `PUT /api/ai/capabilities/*` (legacy `PATCH /api/settings` keeps its write-through, so both paths
  stay tested).
- Rollback: revert the PR; the API additions are unused by the old UI, and the legacy fields still
  work because P1's resolver reads whatever the backfill wrote.

### P4 — Call sites route by capability

Chat/plans → `reasoning`; scan/expiry OCR → `vision`; review (route + cron) → `decision` via
`decide()`; usage rows carry `capability`; `/api/ai/usage` and `/api/admin/ai/usage` gain the
breakdown; delete `lib/ai.ts`, `ai-access.ts`'s access types, and the `plans.ts` inline JSON parse;
resolve once per run in the sweep and pass the handle.

- Tests: per-route capability assertions (a fake provider records the capability it was called for),
  scan uses the vision model (the fix), review verdict from a typed provider (reason NULL) and from a
  chat provider (reason present), an empty account gets 402 on every AI route and the review sweep
  makes **zero** calls (still degrading to manual), usage rows include capability, the sweep still
  writes **one** batch and reads **one** capability row per run.
- Rollback: revert; P3's UI edits and P1's data stay valid, chat/plans/scan revert to the shim.

### P5 — Persona and key test behind the door; browser loses provider access

`POST /api/ai/generate/persona` (reasoning) replaces `generatePersonaCopy` (`persona.js:121-186`);
`testAiKey` (`persona.js:281-330`) delegates to `POST /api/ai/providers/:id/test`; delete the frontend provider
clients and `frontend/src/lib/aiProviders.js` (the "keep in sync" duplication,
`aiProviders.js:1-11`), fetching labels/defaults from `/api/ai/presets` instead.

- Tests: persona route (auth, rate limit, prompt isolation), Settings persona flow, and the
  `frontend-ai-boundary.test.js` hostname ban now green.
- Rollback: revert; the old browser path is self-contained and needs no server support.

### P6 — Cleanup and the destructive drop

`migrations/0040_drop_user_settings_ai.sql` (drop `ai_provider`, `encrypted_ai_key`, `ai_base_url`,
`ai_model`, `ai_vision_model`, `ai_thinking_level`), remove the legacy `/api/settings` AI fields and
`POST /api/ai-key/test`, delete the shim and `USER_AI_SETTINGS_COLUMNS`, update
`docs/ARCHITECTURE.md` §7 and regenerate `docs/API.md`.

- Tests: full suite green with the columns gone; settings GET/PATCH no longer mention AI.
- Rollback: the code reverts, but the **columns are gone** — this PR needs an owner-approved D1
  backup immediately before deploy (`scripts/` backup path) and must not ship in the same week as a
  schema-sensitive deploy. It is deliberately last and deliberately alone.

**Why this order:** enforcement before the move (P2's boundary test exists before P4 relocates five
call sites), data before behaviour (P1 before P4), UI before call-site changes so a user can always
see and fix what the runtime resolves (P3 before P4), and destruction last and isolated (P6).

---

## 7. Risks and open questions for the owner

The three questions this section carried at review time were **decided by the owner on 2026-11-07**
and now live in §0 as **D2** (four wire adapters), **D3** (typed decision contract) and **D8** (no
server fallback). What follows is the risk list and the questions that are still open.

### Risks

1. **Subrequest budget.** The Workers free plan allows 50 subrequests per invocation and the review
   sweep budgets ~47 for 20 items (`review-ai.ts:60-66`). A per-item capability read would add 20
   reads and blow it. Mitigation is in the design: `resolveAccess` once per run, `AiAccessHandle`
   reused, no per-call DB reads. P4's test pins "one capability read per sweep".
2. **Key blast radius.** Today one `encrypted_ai_key` per user; after this change, N per user, all
   under the same `WORKER_ENCRYPTION_KEY`. Rotating that key already invalidates every stored key
   (`docs/ARCHITECTURE.md:478`); now it invalidates N per user. Option: bind the ciphertext to the
   provider row id as AES-GCM additional data (a `crypto.ts` change) so a copied ciphertext cannot
   be re-planted on another row — worth doing in P2 if we accept touching `crypto.ts` (OQ2).
3. **Behaviour change disguised as a fix.** Receipt scan switching to the vision model (§5.5) can
   surprise a user whose text model was doing fine. Mitigation: release note, and the UI shows
   "Vision model" on the scan path; the vision assignment inherits the migrated `ai_vision_model`
   which, when unset, is the old text model — so nothing changes for users who never set it.
4. **No safety net, by design.** D8 removes the platform key, so a user who deletes a provider — or
   whose key stops decrypting — gets 402 and the feature degrades (review assist/auto → manual, chat
   unavailable) with nobody to bill but themselves. That is the intended trade, but it puts real
   weight on the empty state and on the 402 copy being actionable ("Add a provider in Settings"),
   and on `ai_status` telling the truth per capability. P3 tests the copy, P4 tests the degradation.
5. **Two sources of truth during P1–P5.** Legacy columns and new tables coexist; every write path
   must write both (from P1 on) or the compatibility window produces drift. Mitigation: the write-through is
   one function with its own test, and P6 removes the ambiguity.
6. **Typed-decision answers are thin — accepted by D3.** Choice + confidence only: no reason, no
   tokens. Consequences: `review_ai_verdicts.reason` is empty under a `questions` provider, and the
   admin cost view shows zero tokens for those calls (OQ4). Both are visible, not hidden.

### Open questions

1. **Whose keys are these?** Per-user today (`user_settings`), which is why `ai_providers.user_id` is
   per-user. A family sharing one key would need `household_id` ownership plus an attribution rule
   for `ai_usage_events.user_id`. Recommendation: keep per-user for v1; revisit with the household
   plan.
2. **Encryption hardening.** Bind the provider ciphertext to its row id (risk 2)? It is a small
   `crypto.ts` change but it invalidates existing ciphertexts, so it must land with a
   re-encrypt-on-read or a forced key re-entry.
3. **Embeddings now or later?** Recommendation: later. A fourth capability is an additive enum value
   plus a new adapter method, but embeddings have a different shape (no messages, no completion,
   different usage units) and no feature needs them yet. Modelling them now would make `decide()`'s
   simplicity worse.
4. **Token accounting for typed providers.** Accept zeros (recommended, with `provider='questions'`
   as the marker) or add a per-call counter so the admin view stays meaningful?
5. **Local/private endpoints.** The HTTPS-only rule (`api.ts:1198-1200`) blocks a self-hosted Ollama
   on `http://192.168.x.x`. Allow private-network HTTP for user-owned base URLs (a real SSRF surface
   on Workers, which cannot reach the LAN anyway) or keep HTTPS-only? Recommendation: keep HTTPS-only.
6. **Legacy column drop timing (P6).** One full release after P5? The PWA and any mobile wrapper must
   be observed in the wild before the columns go.
7. **Decision on chat providers.** Should a chat provider be assignable to `decision` (JSON prompt and
   prompt-parsed choice) at all, or only a typed provider? Recommendation: allow both — the migration
   itself assigns the legacy chat provider to `decision`, and a user with one key would otherwise lose
   the review feature.
8. **Per-provider rate limiting.** A single bad key can 429 repeatedly; today only the OCR route is
   limited (`plugins/documents/ocr.ts:46-54`). Add a per-user AI rate limit in P4, or leave it to the
   provider's own quota?
9. **Should the provider test be free?** A typed-decision test is a billable question. Alternatives:
   probe with an intentionally empty `questions` object and accept a 400 (proves auth, no billing) —
   needs the provider's confirmation.

---

## 8. References

- Issue: `ahaqqu/RumaQ#523`; owner directive quoted in the issue body.
- `backend/src/lib/ai.ts`, `ai-access.ts`, `chat.ts`, `plans.ts`, `review-ai.ts`, `document-ocr.ts`.
- Migrations `0001`, `0008`, `0009`, `0015`, `0033`, `0038`.
- `docs/ARCHITECTURE.md` §7 (AI integration), §9 (env table).
- `docs/plan/plugin-architecture.md` §4.2 (port/adapter precedent), §7 (phase-as-PR style).
- `RumaQ-pipeline/groceries/scraper/src/categorize/jev.ts` (the typed-decision wire, for reference
  only — no code is shared).
