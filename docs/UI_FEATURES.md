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
- Search products; filter by store; sort by cheapest / biggest saving / name / expiring soon.
- See promos with the deal type (discount %, fixed discount, buy-one-get-one, bundle, …), savings %, and how long the price is still valid.
- See how fresh the data is (last scrape time).
- Open each product's per-store price detail: cheapest store highlighted, price gap vs cheapest, and a price-history sparkline.
- Browse the actual brochure pages behind the prices, per store and date, and jump from a brochure item to its price detail.

### Ask the AI (Assistant)

- Chat with an AI assistant about your household shopping.
- One-tap prompts: plan this week, recommend the cheapest store, recipes for expiring items.
- See AI usage status (calls today + token counts; usage is recorded but never capped, own key or shared server key alike).
- Turn an assistant answer into a shopping plan in one tap.
- The assistant answers use your household's real data (stock, history, prices).

### Personalize & configure (Settings)

- Choose an AI provider (OpenCode/OpenAI/Anthropic/Gemini/Ollama Cloud/custom endpoint), set model, thinking level, and API key; test the connection; see usage (calls + tokens + cache hit rate).
- Define a persona ("I am … , you are …") that AI-rewrites the app's tone and recolors the theme; preview and enable/disable it.
- Manage storage locations (add/delete).
- Manage recorded stores (add/delete).
- Set motion preference (none/reduced/standard) and language (English/Indonesian).

### Operator tools (admin users only)

- **Scraper monitor:** see whether last night's price scrape succeeded, per-run outcomes (stores scraped, items matched, publish results, errors), and when the last success was.
- **Review queue:** judge AI-flagged product matches side by side (approve/reject/undo), filter by status, export decisions.
- **Scrape now:** trigger an on-demand scrape of selected stores and watch the live log until it finishes.
- **AI usage:** totals (calls, input/output tokens, cache hit rate) and a per-user breakdown over the last 24 hours / 7 days / 30 days.

## 4. Information & behaviors any UI must support

### Data shown per area (minimum)

- **Stock item:** name, location, qty + unit, expiry date and/or estimated run-out days, estimate basis.
- **Plan item:** name, qty + unit, store, price estimate, reason, price source + validity, bought/pending status.
- **Purchase:** date, store, total, line items (name, qty, unit, price), receipt availability.
- **Price row:** product name/brand/unit, current price, tag price when discounted, promo labels, savings %, validity countdown, stores offering it, price freshness.
- **AI usage:** calls today, input/output tokens, cache hit rate (only when the provider reports cached tokens); no limit meter.

### States that carry meaning (not just polish)

- **Urgency levels** on stock (ok → soon → critical) — the core signal of the app.
- **Loading** for every async area; **empty** states that explain the next action (e.g. "scan your first receipt"); **error** with retry.
- **Offline mode:** the app is a PWA and works offline with cached data; changes made offline must survive and sync.
- **Optimistic feedback:** quantity changes, check-offs, and decisions should feel instant.
- **AI availability:** the app is usable without any AI key (inventory works; AI features show how to enable them). Usage is recorded but never capped, so there is no quota-exhaustion state; provider failures surface as errors.
- **Two languages** (EN/ID) for all text; admin sections hidden from normal users.

### Hard functional flows to preserve

1. Receipt photo → review → confirm → stock + history updated. Confirmation before anything is written is mandatory (AI can be wrong).
2. Generate plan → optionally regenerate → save → check off items → stock reflects purchases.
3. Assistant answer → apply as plan.
4. Qty adjust → home stats and urgency stay consistent.
5. Admin: run → inspect → review flagged matches → (re)scrape on demand.

## 5. Constraints & scope notes for the rewrite

- **Platform:** responsive web PWA (mobile-first; installable; offline-capable). No native apps.
- **Single household per user** for now (multi-household is planned backend work — design must not paint us into a corner, but no UI needed yet).
- **No push notifications** (deferred product decision).
- **Mobile is the primary context:** scanning receipts and checking off a plan happen in a supermarket.
- **Trust matters:** AI-suggested data is always presented as editable suggestions, never silently applied; estimates are shown with their basis.
- **Currency:** Indonesian Rupiah (Rp), no decimals.
