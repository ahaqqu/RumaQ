# RumaQ — Figma Prompt Series (each ≤ 2000 chars)

Paste in order. Each prompt is standalone (context line repeated). Prompt 0
defines the visual language distilled from the approved Home mockups
(`docs/design/tokens.md`) — **paste it together with any screen prompt** so
every generation matches the established look. Prompts 1–10 generate the whole
app; use the matching prompt per screen as you go.

## Prompt 0 — Design language (prepend to every screen prompt)

```text
RumaQ — household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, prices in Rp.

Design language — apply to every RumaQ screen (established by the Home mockups):
Colors: page bg #F7F7F0; cards/surfaces #FFFFFF; hairline borders #E2E6DC; primary green #245C43 (brand, selected nav, primary buttons, links); soft green tint #E9F0E5 (selected fills, banners, status chips, secondary buttons); inset tile #F0F2EA (avatar/account tiles); text #20352C primary, #69756C muted; white on green.
Type: Inter. Page title 34/41 semibold -1px tracking; empty-state title 23 semibold; nav 14 (600 green selected / 500 muted); body 14/145%; secondary 12/145%; micro labels 10 semibold uppercase +1px; chip 11 semibold; links 13. Mobile bottom bar is icon-only (26px icons, no labels).
Radius: frame 20 · cards 18 · buttons/nav/banners 10 · tiles 12 · illustration tile 28 · assistant pill 100.
Spacing: sidebar 240 (padding 24, block gap 32); header 88 tall (desktop), 53 (mobile), 36 side padding; content padding 36, section gap 26; cards padding 16, row gap 24. Page scrollbar hidden on all breakpoints.
Icons: Lucide 1px stroke (sprout, house, package, calendar-days, receipt-text, chart-no-axes-combined, settings, sliders-horizontal, users, user-round, log-out, scan-line, cloud-check, check, arrow-right, sparkles).
Components: selected nav = soft-green fill + 5px dot; primary button = green fill, white 600 label, h48; secondary = soft-green fill, green label; status chip = soft-green pill + icon; empty state = 88px soft-green illustration tile, centered title, muted desc, full-width soft-green action + 12px helper line; AI assistant = raised solid-green sparkles tile centered in the mobile tab bar, floating white icon-pill with green border bottom-right on desktop; connectivity banner = soft-green bar with cloud icon. Mobile top + bottom bars slide away while scrolling and return ~1.2s after scrolling stops (X-app behavior).
```

## Prompt 1 — App context, shell & global states

```text
RumaQ — a household grocery assistant for Indonesian families. Core promise: you never track stock manually. Snap a receipt photo, AI reads items/prices/store, inventory updates itself; run-out is estimated from your shopping habits. Design a completely fresh UI (do not copy any previous look). Platform: mobile-first responsive PWA (phone is the primary context: kitchen + supermarket), works offline, English + Bahasa Indonesia, prices in Rp (no decimals). Principle: AI suggestions are always editable, never silently applied.

First, design the app shell (implemented in the Home redesign — match it):
• Mobile: bottom tab bar — Home, Inventory, a raised solid-green center "Ask RumaQ" assistant action, Plan, Prices (icon-only, five equal slots). A Google-Calendar-style left drawer opens from the brand mark: household card, Home/Inventory/Plan/History/Prices, Settings, household-admin tools for admins, account block. Settings via a header icon too. The receipt capture ("Post photo") lives inside the assistant panel's action menu.
• Desktop: 240px sidebar — brand, household card, nav (selected = soft-green fill + small dot marker), a "Household admin" micro-label group for admin tools, account block (logout lives in Settings). Header: breadcrumb "Your household / {page}" + today's date, EN/ID switcher, primary "Add from Receipt".
• Global overlays: offline banner ("you're offline — changes sync when you reconnect"), app-update toast ("new version available — reload").
• Every screen needs these states designed: loading (skeletons), empty (explain the next action, e.g. "scan your first receipt"), error (with retry), and an app-wide urgency color language: green = ok, amber = soon, red = critical.
```

## Prompt 2 — Home dashboard

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screen: Home dashboard (implemented — match the approved frames). Goal: answer "what's at home and what needs attention now?" within 5 seconds.
Show:
• Time-of-day greeting with the user's name ("Good morning, Putri") + tagline + a "Your kitchen companion" chip.
• Desktop: three stat cards — "In your kitchen: 24 essentials · Confirmed inventory", "Worth a look: 3 running low · Estimated from your habits", "{Month} spending: Rp 1.245.000 · 8 confirmed receipts". Mobile: one green hero card ("Your kitchen, at a glance · 24 essentials · 3 may run low this week").
• "A little attention today" (mobile label: "Use soon"): item rows — name, quantity + unit, "estimated N days left", badge Critical (red) / Low soon (amber) / Watch (muted); footnote "Estimates, not exact counts. Open any item to edit."; rows open Inventory.
• Next-trip teaser (only when a plan exists): store name(s), item count, total estimate, "View plan".
• Recipe card ("Tonight, keep it simple"): opens the AI assistant pre-seeded with a find-a-recipe request; shown only when items need attention.
States: loading skeletons; empty = "All safe"; spending stat updates from confirmed receipts.
```

## Prompt 3 — Inventory

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screen: Inventory — "what's at home".
Capabilities:
• Full stock list, most urgent items first.
• Search by name; filter by storage-location chips (fridge, freezer, cabinet, rack — user-managed list).
• Inline quantity adjust per item (+/−): instant optimistic feedback, minimum 0, no navigation needed; dashboard stats stay consistent.
• Per item show: name, location, quantity + unit, and one urgency signal — days to expiry OR estimated run-out derived from the household's purchase rhythm; the estimate's basis must be inspectable (e.g. "estimated from the last 4 weeks of shopping").
• The list is the single surface — no item detail page exists; don't design flows that require one.
States: loading skeleton; no search results = "no matching items — try other keywords or clear the location filter"; completely empty stock = invite to scan the first receipt.
```

## Prompt 4 — Add from receipt (flow)

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Flow: Add from receipt — the app's magic moment. 4 steps, one screen at a time:
1 Capture: large camera/upload affordance (rear camera on phone), drag-and-drop on desktop; accepts JPEG/PNG/HEIC/WEBP up to 5 MB; instant validation messages ("unsupported file type", "file too large — max 5 MB").
2 Scanning: clear progress state — "reading receipt… recognizing items, prices, and store" (never a dead spinner).
3 Review (mandatory — AI can be wrong; nothing is saved before the user confirms): editable list of scanned lines — name, qty, unit, price; each line can be matched to an existing known item or kept as new; store picker (prefilled with AI's guess) and date; running total; receipt photo thumbnail; "retake photo" escape hatch.
4 Done: success summary ("stock increased by 7 items"), note that stock and history updated automatically, actions: "add another receipt" and "done" → inventory.
AI errors (missing key / provider config) must explain the problem and link to Settings.
```

## Prompt 5 — Shopping plan

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screen: AI shopping plan — turns "what's running low + your habits" into shopping trips.
Capabilities:
• Generate (AI): items grouped per store; each item shows name, qty + unit, a plain-language reason ("why"), a price estimate, and when available the price source ("from Superindo's brochure, valid until 2 Nov").
• Per-store subtotals + grand total, always in Rp.
• Draft state: review before saving — regenerate (AI tries again) or discard; then save.
• Active plan: check items off while shopping; bought items lock (no un-checking); checking automatically updates home stock. All-done state: positive summary + "stock updates from your next receipt" + one-tap "plan next trip".
• A proposal arriving from the AI assistant appears as a preview banner ("apply to plan") that can be dismissed.
States: no AI key = explain the value + "connect key" action (the rest of the app still works); generating = skeleton; no active plan = prompt to generate.
```

## Prompt 6 — Purchase history

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screen: Purchase history — the trust + insight layer.
Capabilities:
• All past purchases grouped by month; each month shows count + subtotal; overall total and monthly average visible without mental math.
• Each purchase shows: date, store, total, line items (name, qty + unit, price), and whether the original receipt photo is available.
• Filters: item search, store picker, from–to date range; changing a filter resets pagination.
• Tap a purchase to view its original receipt photo full-screen.
• Pattern insights: recurring items ("milk — every ~7 days, avg 2") with one-tap "turn into plan" via the AI assistant.
• Long lists paginate ("load more") — never drop data silently.
States: loading; error with retry; empty = "no purchases yet — add a receipt to start tracking your spending".
```

## Prompt 7 — Prices

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screen: Prices — "pay the right price". Data comes from supermarket promo brochures, scraped regularly. Three switchable views:
A Products (default): searchable list; filter by store; sort by cheapest / biggest saving / name / expiring soon. Each row: product + brand + unit, number of stores selling it, current price vs struck-through tag price when discounted, promo badges (discount %, buy-one-get-one, bundle…), savings %, validity countdown ("ends today" / "3 days left" / "expired" in red), and a data-freshness stamp ("prices updated 2h ago" — amber when stale >26h). Expanding a row reveals per-store comparison: cheapest highlighted, price gap vs cheapest, per-store promos, low-confidence-match warning, and a small price-history sparkline.
B Promos: deals grouped by type with counts + example products; tapping a product jumps to its detail.
C Brochures: actual brochure pages grouped by store and date; tap a product → detail.
Empty/error copy should say data comes from the daily brochure scan — check back tomorrow.
```

## Prompt 8 — AI assistant

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Overlay: AI assistant — "ask anything about my household shopping". Reachable from every screen: on mobile via the raised solid-green sparkles tile centered in the tab bar; on desktop via a floating white icon-pill with green border, bottom-right. The panel's action menu leads with the "Post photo" receipt-capture shortcut.
Capabilities:
• Status header: title with a state dot (green ok / amber near limit / muted at limit) whose aria-label carries the quota; not connected → explain value + "add key" shortcut (the app still works without AI).
• Action menu: "Post photo" capture shortcut + three one-tap prompts: "plan this week", "cheapest store for my usual items", "recipes to use up expiring items".
• Free-text questions; answers are grounded in real household data (stock, history, prices).
• Thinking state; graceful errors: quota reached (explain, offer key), no key, generic failure with retry.
• Key action: turn an answer into a shopping plan in one tap ("apply to plan") — closes the assistant, lands on the Plan screen with the proposal previewed and dismissible.
Show the latest reply only; no full chat-history thread needed in v1.
```

## Prompt 9 — Settings

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screen: Settings — control + personalization, grouped sections:
• AI: choose provider (OpenCode / OpenAI / Anthropic / Gemini / Ollama Cloud / custom OpenAI-compatible endpoint); model + thinking level; API key (masked; if one exists, "leave blank to keep existing"); "test connection" with clear success ("AI can create plans and read receipts") or failure feedback; status line: active / using shared key (20 requests/day) / not connected; usage meter with warning states.
• Persona (unique feature): "I am … , you are …" roles — AI rewrites the app's tone and recolors its theme; preview before enabling; on/off; has a no-key fallback mode.
• Storage locations: add/delete (fridge, freezer, …) — feeds inventory filters.
• Recorded stores: add/delete — feeds purchases, plans, and prices.
• Display: motion preference (none / reduced / standard) + language (English / Bahasa Indonesia) — both apply instantly.
All feedback inline (no toasts); deletes are immediate; edits are disabled offline with hint "available when you're back online".
```

## Prompt 10 — Operator tools (admin)

```text
RumaQ: Indonesian household grocery assistant; never track stock manually — AI reads receipts and inventory updates itself. Mobile-first PWA, offline-capable, EN/ID, Rp.

Screens: operator tools — visible only to admin users; information density over aesthetics.
1 Scraper monitor — "is price data healthy?": last successful scrape with staleness warning ("over a day old — nightly scrape not landing", red); run history: time, duration, stage, success/fail; expandable per-run detail (stores scraped, pages, items, rejected; matching stats; publish results; full error text).
2 Review queue — AI-flagged product matches need human judgment: side-by-side comparison (scraped item vs catalog entry: name/brand/unit/price/store); confidence %, match method (exact/embedding/AI), flag reason, times flagged; actions approve / reject / undo; status counts always visible (pending/approved/rejected); filter chips; paginated; export decisions.
3 Scrape now — pick stores, trigger an on-demand scrape; one run at a time (busy state explained); live streaming log (auto-scroll, timestamps, errors in red) with elapsed timer; history of past commands with full logs.
```
