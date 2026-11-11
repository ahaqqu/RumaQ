# RumaQ — What the App Does (Functional Overview for a UI Rewrite)

This document describes **what users can do and what value they get** — not how the UI
looks. It is the functional brief for a full UI rewrite (Figma / Lovable): any visual
design is acceptable as long as every capability and piece of information listed here
remains reachable.

---

## 1. Product in one paragraph

RumaQ is a household grocery assistant for Indonesian families. The core promise:
**you never track stock manually.** Snap a photo of a shopping receipt; AI reads the
items, quantities, prices, and store; the app keeps a running inventory of what you
have at home, estimates when things will run out **based on your actual shopping
habits**, tells you what to buy next, and shows which nearby store has the best price —
so you waste less food, shop in fewer trips, and spend less.

## 2. The value users get

| Value                          | How the app delivers it                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Zero-effort stock tracking** | Receipt photo → AI OCR → stock updated automatically. Run-out estimates come from purchase rhythm, not manual counting.                                                  |
| **Less food waste**            | Expiry countdowns and "needs attention" awareness for items expiring or running out within days.                                                                         |
| **Smarter shopping trips**     | AI builds a shopping list from what's running low, grouped per store, with price estimates grounded in real brochure prices.                                             |
| **Pay the right price**        | Product prices across supermarkets, scraped from weekly promo brochures; promos, savings %, and per-store price history.                                                 |
| **Spending insight**           | Purchase history with monthly totals, averages, and recurring-purchase patterns.                                                                                         |
| **Ask anything**               | An AI assistant that can plan the week, recommend the cheapest store, or suggest recipes to use up expiring items — and turn its answer into a shopping plan in one tap. |
| **Feels personal**             | Optional AI persona that rewrites the app's tone for you, plus English/Indonesian language.                                                                              |

## 3. What the user can do (capabilities)

### Account

- Sign in with Google; optionally with email/password (if enabled).
- Sign out.
- First login automatically sets up a household with default storage locations and stores.

### Know what's at home (Dashboard)

- See at a glance: how many items are tracked, how many expire soon, how many are nearly out.
- See which specific items need attention (low stock / expiring) with quantity and urgency.
- See the next planned shopping trip (store + items) and jump into it.
- Get tips (e.g. recipes for items expiring soon) and shortcuts to key actions.

### Manage stock (Inventory)

- Browse everything currently in stock, most urgent first.
- Search by name; filter by storage location (fridge, freezer, cabinet, …).
- Increase/decrease any item's quantity inline (e.g. after using something).
- Each item shows: name, location, quantity + unit, and urgency (days to expiry or estimated run-out, with how confident the estimate is).

### Add stock without typing (Receipt scan)

- Take a photo or upload a receipt image (JPEG/PNG/HEIC/WEBP, ≤5 MB).
- AI reads: items, quantities, units, prices, store, date.
- Review and correct everything before confirming: fix names, match lines to known items, edit qty/unit/price, set store and date, see the total.
- On confirm, a purchase is recorded and stock is updated automatically.
- Scan again immediately, or finish back to inventory.

### Plan shopping (AI Shopping Plan)

- Generate a shopping plan from what's running low + purchase history.
- The plan is grouped per store with item quantities, a reason per item ("why"), price estimates, and — when available — the price source ("from X's brochure, valid until …").
- Regenerate if unsatisfied; save the plan; discard a draft.
- Check items off while shopping (bought items update stock). See per-store subtotals and grand total. When everything is bought, start the next plan in one step.

### Look back (History)

- See all past purchases grouped by month with monthly totals and a monthly average.
- Filter by store, date range, or item search.
- View the original receipt photo for any purchase.
- See detected buying patterns (e.g. "milk, every ~7 days") and turn them into a plan.

### Pay less (Prices)

- Compare current prices of products across supermarkets.
- When a supermarket prints a member/app price, it is the headline (labelled **Member price**) and the shelf price is shown as the reference; cross-store comparisons, savings %, and the cheapest store use the member price when it is lower — a member price above the shelf/promo basis never raises the payable price — and shelf-only items are unchanged.
- Search products; filter by store; filter by category with one searchable picker (the sealed taxonomy slugs plus "All categories", keyboard-navigable, hidden until categories exist); sort by cheapest / biggest saving / name / expiring soon.
- See promos with the deal type (discount %, fixed discount, buy-one-get-one, bundle, …), savings %, and how long the price is still valid.
- See how fresh the data is (last scrape time).
- Open each product's per-store price detail: member price as the headline with the shelf reference, cheapest store highlighted, price gap vs cheapest, and a price-history sparkline (history is still shelf-based in v1).
- Prices is a read-only explorer for every household member, admins included; the operator/QA tools live in the admin catalog (see Operator tools).

### Ask the AI (Assistant)

- Chat with an AI assistant about your household shopping.
- One-tap prompts: plan this week, recommend the cheapest store, recipes for expiring items.
- See AI usage status (calls today + token counts; usage is recorded but never capped — there is no platform key and no rate limit, #523). Every call is funded by the household's own provider key.
- Turn an assistant answer into a shopping plan in one tap.
- The assistant answers use your household's real data (stock, history, prices).

### Personalize & configure (Settings)

- **AI providers:** add up to ten of the household's own providers (label, wire protocol, optional vendor preset, base URL, optional default model, API key), edit them, delete one (a confirmation names the capabilities that will become not configured), and test a provider's connection — the answer is an outcome, never the provider's error body. The key is write-only: the list says "key saved", never the value. Nothing is preselected and there is no "use the server default" option: a household with nothing configured sees the empty state, and there is no provider until someone adds one.
- **AI capabilities:** assign a provider to each of three fixed jobs — Decision (structured choices: review verdicts, classification, JSON answers), Reasoning (chat and shopping plans), and Vision (receipts and documents) — with an optional model per job (blank inherits the provider's default) and a thinking level for Decision and Reasoning. Nothing is preselected; a blank model everywhere means the capability is not configured and its feature says so; Vision has no thinking knob; the three rows only appear once a provider exists.
- **Read-only for members:** a member sees the same providers, capabilities and resolved status, marked "Managed by <owner>", with every add/edit/delete/test/save control absent — the API decides with `can_manage`, so the UI never guesses from the role.
- See AI usage (calls + tokens + cache hit rate; recorded, never capped).
- Define a persona ("I am … , you are …") that AI-rewrites the app's tone and recolors the theme; preview and enable/disable it.
- Manage storage locations (add/delete).
- Manage recorded stores (add/delete).
- Set motion preference (none/reduced/standard) and language (English/Indonesian).

### Operator tools (admin users only)

- **Scraper monitor:** see whether last night's price scrape succeeded, per-run outcomes (stores scraped, items matched, publish results, errors), and when the last success was.
- **Review queue:** judge flagged product matches side by side (approve/reject/undo), filter by status and by flag reason (price ratio / verifier unresolved / taxonomy), see the exact pending total split by reason (`Pending 482 — price 400 · verifier 50 · taxonomy 32`), export decisions. The counts are exact whole-queue reads — the filters only change the list. Each row says what flagged it — an implausible price gap, an unresolved AI verifier, or a low-confidence category classification; the last is a category question the AI does not judge, so it never carries an AI verdict and stays a human decision.
- **AI review mode:** choose manual triage, approve-with-AI (default — the AI proposes a verdict with confidence and reason, and you agree or disagree), or full auto (the AI decides on its own at or above the confidence floor the server returns — 80% today — and the queue evaluates automatically every 30 minutes); the header shows how many items are waiting for AI and an on-demand "Evaluate more" (opening the page runs one bounded batch), verdicts show their model and a collapsible reason, and decided rows say whether a human or the AI decided (and whether the human agreed).
- **Admin catalog:** an admin-only area with two sections. **Products & identity** is a product lookup (same search/store/category filters as the prices explorer) whose expanded detail carries the rename action, the duplicate-name report, and the alias-candidates panel; a `#productKey` deep link opens and expands the product. **Brochures** is the ingestion-QA browser: filter the actual brochure pages behind the prices by store and observed date, then select a card to review every current product on that page in a full-width table (paginated, no example cap). Clicking a product row expands its complete ingestion metadata in place — product key, store, observed date, brochure URL, validity window, member and shelf price, promo fields, match method/confidence, and scraped_at — without leaving the view or jumping into the product lookup.
- **Rename a canonical product:** fix a product's name without changing its identity — see the current name, the observed name variants (store/status/source) and observation stats; preview old → new; add an optional reason; see whether the new name collides with an existing product (blocked) or is only similar to one (warned, overridable). The audit trail keeps every change, and the latest rename can be reverted after a confirmation. Reachable from the admin catalog's product detail and from the review queue's catalog side (the flagged pair keeps its frozen label).
- **Candidate alias decisions:** approve or reject a store's spelling of a canonical product in that same variant list — candidate rows offer Approve/Reject, already-decided rows show their state. Approving adds the spelling to the canonical index (the confirmation names the new index version); rejecting keeps it out and leaves the version unchanged, and asks for a second inline click ("Confirm reject?" / Cancel) because the decision is terminal and there is no reset route (the question closes on its own after ten seconds). If another admin decided the row first, the list refreshes and says so. Every decision is final and audit-recorded.
- **Bulk alias approval:** the admin catalog carries an alias-candidates panel beside the duplicate-name report — the catalog-wide candidate count and how many of them exactly restate their own product's canonical name. One confirmation ("Approve exact matches", naming the count) approves only those: case-insensitive exact matches, one audit receipt per approval with the acting admin, and a single canonical-index bump for the whole run (one run is bounded by the Worker invocation's D1 query budget — 1,125 exact matches today — so a larger catalogue continues on the next click, with the refreshed counts naming the remainder). Whitespace, size, and wording variants are never approved in bulk — they stay a manual decision in the rename form — a second run approves nothing and does not bump the version, and a run that stops mid-way reports how many aliases were already approved.
- **Duplicate names report:** a read-only panel on the admin catalog lists the canonical products that share a name (case-insensitive) with each product key, status, observing stores, and last update — the collisions a racing rename or a rename inside the pipeline's cached-index window can leave behind. Nothing is merged, renamed, or enforced from it; the empty state says there are none, and the report only loads when an admin opens it.
- **Scrape now:** trigger an on-demand scrape of selected stores and watch the live log until it finishes.
- **AI usage:** totals (calls, input/output tokens, cache hit rate) and a per-user breakdown over the last 24 hours / 7 days / 30 days.

## 4. Information & behaviors any UI must support

### Data shown per area (minimum)

- **Stock item:** name, location, qty + unit, expiry date and/or estimated run-out days, estimate basis.
- **Plan item:** name, qty + unit, store, price estimate, reason, price source + validity, bought/pending status.
- **Purchase:** date, store, total, line items (name, qty, unit, price), receipt availability.
- **Price row:** product name/brand/unit, current price (member price labelled when printed, shelf price as the reference), tag price when discounted, promo labels, savings %, validity countdown, stores offering it, price freshness.
- **AI usage:** calls today, input/output tokens, cache hit rate (only when the provider reports cached tokens); no limit meter.

### States that carry meaning (not just polish)

- **Urgency levels** on stock (ok → soon → critical) — the core signal of the app.
- **Loading** for every async area; **empty** states that explain the next action (e.g. "scan your first receipt"); **error** with retry.
- **Offline mode:** the app is a PWA and works offline with cached data; changes made offline must survive and sync.
- **Optimistic feedback:** quantity changes, check-offs, and decisions should feel instant.
- **AI availability:** the app is usable with no AI configured (inventory works; AI features say to set AI up in Settings). Usage is recorded but never capped, so there is no quota-exhaustion state; provider failures surface as errors that name the capability to fix. There is no shared/server key, so no screen may imply one (no "platform key", no "unlimited on our key").
- **Two languages** (EN/ID) for all text; admin sections hidden from normal users.

### Hard functional flows to preserve

1. Receipt photo → review → confirm → stock + history updated. Confirmation before anything is written is mandatory (AI can be wrong).
2. Generate plan → optionally regenerate → save → check off items → stock reflects purchases.
3. Assistant answer → apply as plan.
4. Qty adjust → home stats and urgency stay consistent.
5. Admin: run → inspect → review flagged matches → (re)scrape on demand.

## 5. Constraints & scope notes for the rewrite

- **Platform:** responsive web PWA (mobile-first; installable; offline-capable). No native apps.
- **Multi-household is live** (issue #331): the sidebar household card links into a "Household members" screen under Household Admin (member list, owner-issued invite codes, join by code, active-household switching, create household). The redesign's household card ("Keluarga Putri · 4 people") is backed by real data; every data view stays scoped to the active household.
- **Two-mode members** (issue #388): the members screen's "Add person" flow has two modes — invite an existing user (share code) or add a profile-only member with no account (display name + optional birth date; e.g. a toddler). Profile-only members render with a "no account" chip, never authenticate, and are owner-managed; they count toward the household size.
- **Link-later invites** (issue #397): when generating an invite code the owner can mark it "for" one profile-only member (a selector listing only the has_account=false roster rows). Marked invites show "For: <name>" on the owner screen; the first person to redeem joins AS that member — their account attaches to the existing row, keeping its name, birth date, and vault documents, with no duplicate roster row.
- **No push notifications** (deferred product decision).
- **Mobile is the primary context:** scanning receipts and checking off a plan happen in a supermarket.
- **Trust matters:** AI-suggested data is always presented as editable suggestions, never silently applied; estimates are shown with their basis.
- **Currency:** Indonesian Rupiah (Rp), no decimals.
