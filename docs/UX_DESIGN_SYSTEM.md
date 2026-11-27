# RumaQ UX & Design System Guide (Agent-First Spec)

> **Audience**: AI coding/design agents and human reviewers building RumaQ UI.
> **Purpose**: Single source of truth for UX philosophy, visual tokens, information architecture, component contracts, copywriting, iconography, and AI mascot behavior. Follow these rules on every frontend PR unless the owner explicitly approves a deviation.
> **Reference Prototype**: [`frontend/public/prototypes/v3/v1-editorial-hangat.html`](../frontend/public/prototypes/v3/v1-editorial-hangat.html) · **Logo**: [`frontend/public/prototypes/v3/logo-rumaq-v3.svg`](../frontend/public/prototypes/v3/logo-rumaq-v3.svg).

---

## 1. Product Philosophy & Core Principles

RumaQ is **not an online store** (no checkout, no cart payment). RumaQ reads official supermarket promo brochures behind the scenes (scrape + OCR + parsing) and turns them into a calm, trustworthy **price-comparison & shopping-plan companion** for Indonesian households and Gen-Z/millennial shoppers.

### Non-Negotiable UX Invariants

1. **Answers in 3 seconds, zero fluff**: Never waste above-the-fold space with generic greetings (`"Selamat pagi 👋"`) or redundant marketing banners. Lead immediately with **Search → Savings Summary + Shopping Day → Deals**.
2. **Comparison is the moat**: Every product surface exists to answer _"di mana paling murah, hemat berapa, dan sampai kapan?"_.
3. **Brand (Merk) before generic category**: Indonesian shoppers hunt by brand (`Sania`, `Rinso Molto`, `Raja Platinum`, `Indomie`, `Lifebuoy`). Brand MUST be the largest, boldest text in product cards and detail titles.
4. **Numbers first, currency symbol second**: Always render `"Rp"` smaller (`0.58em`, softer weight/opacity) with `font-variant-numeric: tabular-nums` so eyes lock instantly onto the digits (`64.900`).
5. **Supermarket ≠ kitchen-only**: Supermarkets sell household, bath, laundry, baby, and snack products too. NEVER use `"kebutuhan dapur"` for general promo counts or app-wide copy — use `"barang harian"`, `"kebutuhan harian"`, or `"promo pilihan"`.
6. **Zero account friction**: Useful immediately without login (local preferences + watchlist + checklist). Personalization enhances the feed progressively.
7. **One trigger per job**: Never place two controls on the same screen that perform the identical action (e.g., do not show both `"Ubah hari"` and `"Jadwal belanja"` on Home).
8. **Touch-first & accessible**: Minimum touch target `40×40px` (prefer `44–48px`), minimum readable text `11px` (`12px+` for body), never hide destructive actions behind `:hover`.

---

## 2. Brand Identity & Logo Rules

- **Wordmark**: `RumaQ` in **Fraunces** (Bold `700`, tight tracking `-0.6px`), paired with tagline **`Asisten anti boncos in this economy`** (Plus Jakarta Sans `700`, `--berry`).
- **Logo Mark**: Unified **House + Letter Q / Magnifying Glass** continuous rounded stroke in Berry-Magenta gradient (`#D4145A → #A80A47`) enclosing an optically centered **4-point Golden Sparkle** (`#FBB924 → #EE960B`).
- **Transparency Rule (CRITICAL)**:
  - In-app and web header logos MUST use a **transparent background** ([`logo-rumaq-v3.svg`](../frontend/public/prototypes/v3/logo-rumaq-v3.svg)) so the mark floats cleanly on `#FAF6F0`, `#FFFFFF`, or dark surfaces without a mismatched square box.
  - Only wrap the logo inside a solid squircle container (`#FAF6F0` or `#211C19`) for OS app icons (PWA manifest / Apple Touch Icon / store badges).
- **Do NOT** place the app logo as decorative filler inside content cards (such as the Hero Savings Card).

---

## 3. Theme & Design Tokens (v1 Editorial Hangat)

Warm porcelain surfaces with deep espresso contrast anchors. **Berry-Magenta** and **Golden Amber** are high-signal jewel accents — NEVER flood whole screens in hot pink.

### 3.1 Color Tokens

| Token            | Hex       | Semantic Role                  | Usage Rules                                                              |
| ---------------- | --------- | ------------------------------ | ------------------------------------------------------------------------ |
| `--bg`           | `#FAF6F0` | App canvas (Warm Porcelain)    | Default page & bottom-sheet background                                   |
| `--surface`      | `#FFFFFF` | Primary card surface           | Product cards, brochure cards, watch banner, list rows                   |
| `--surface-2`    | `#F3ECE2` | Inset / muted surface          | Image fallbacks, checked checklist rows, segmented tracks                |
| `--dark`         | `#211C19` | Primary dark anchor (Espresso) | Search bar, Hero Savings Card, Shopping List summary, primary dark pills |
| `--dark-2`       | `#332B26` | Elevated dark surface          | Hover/secondary surfaces on dark anchors                                 |
| `--ink`          | `#211C19` | Primary text                   | Headings, brand names, active store names                                |
| `--ink-2`        | `#62564D` | Secondary text                 | Subtitles, units, helper descriptions (WCAG AA on `#FAF6F0` & `#FFFFFF`) |
| `--ink-3`        | `#9A8C80` | Tertiary / strikethrough       | Old normal prices (`<s>`), inactive tab icons, timestamps                |
| `--line`         | `#EBE2D6` | Default border                 | Card borders, list dividers, nav top hairline                            |
| `--line-2`       | `#DFD3C3` | Strong border                  | Interactive inputs, secondary button outlines                            |
| `--berry`        | `#C20E56` | Brand primary accent           | Primary CTAs, active nav indicator, active badges, promo highlight pill  |
| `--berry-hi`     | `#D81661` | Brand gradient start           | Logo stroke & primary icon tile gradients                                |
| `--berry-deep`   | `#980942` | High-contrast brand ink        | Promo prices, inline links, active labels on soft tints                  |
| `--berry-soft`   | `#FCE7F0` | Soft brand tint                | Subtle badges, delete hover tint, notification icon tile                 |
| `--gold`         | `#F5A617` | Sparkle & discount accent      | Discount badge (`-29%`), calendar today ring, AI sparkle, highlight pill |
| `--gold-soft`    | `#FEF3D4` | Soft gold tint                 | Validity icon tile, avatar surface, watched pill active state            |
| `--gold-ink`     | `#7A4E04` | Text on soft gold              | Accessible label text over `--gold-soft`                                 |
| `--emerald`      | `#0F8A5F` | Verified savings / completion  | Checked ticks, `"Hemat"` badges, full progress bar                       |
| `--emerald-soft` | `#E7F7F0` | Soft savings tint              | `"Termurah"` pill, best-price callout box, WhatsApp share button         |
| `--emerald-ink`  | `#0B6344` | Text on soft emerald           | Accessible text over `--emerald-soft`                                    |

### 3.2 Forbidden Color Patterns

- **NEVER** put multi-stop rainbow/pastel gradients (e.g., yellow-to-pink banners) on secondary cards — keep cards on `--surface` (`#FFFFFF`) or `--dark` (`#211C19`) and express emphasis with a crisp `--berry` or `--gold` accent badge/border.
- **NEVER** use saturated `--berry` as a full-screen background or Hero Card background; reserve `--dark` (`#211C19`) for high-contrast hero containers so `--berry` and `--gold` pills pop cleanly.
- **NEVER** mix leftover teal/cyan tokens from legacy v2 drafts (`#BDE8DD`, `#2A9D8F`).

### 3.3 Typography

| Role                   | Font Family         | Size / Weight / Tracking     | Notes                                     |
| ---------------------- | ------------------- | ---------------------------- | ----------------------------------------- |
| Wordmark               | `Fraunces`          | `23px` / `700` / `-0.6px`    | Header brand lockup                       |
| Page Title (`h1`)      | `Fraunces`          | `24–26px` / `700` / `-0.5px` | Tab view titles                           |
| Section Heading (`h2`) | `Fraunces`          | `19px` / `700` / `-0.3px`    | Home sections, sheet headings             |
| Hero Savings Figure    | `Fraunces`          | `34–36px` / `700` / `-1px`   | Always `.num` + small `.rp` (`0.58em`)    |
| Card Brand (Merk)      | `Plus Jakarta Sans` | `15.5px` / `800` / `-0.3px`  | Primary focus on product cards            |
| Card Promo Price       | `Plus Jakarta Sans` | `22px` / `800` / `-0.6px`    | `--berry-deep`, `.num`, `.rp` at `0.58em` |
| Body / Descriptor      | `Plus Jakarta Sans` | `12–13.5px` / `500–600`      | Product type + unit, helper text          |
| Micro Badge / Pill     | `Plus Jakarta Sans` | `10.5–11.5px` / `700–800`    | Never smaller than `10px`                 |

### 3.4 Shape, Spacing & Elevation

- **Screen horizontal padding**: `18px` (`16px` minimum on narrow viewports).
- **Radii**: Hero & bottom sheet `24–28px`, Product/Brochure cards `20–22px`, List rows & inputs `16–18px`, Icon tiles & action buttons `11–14px`, Pills `999px`.
- **Elevation**: Subtle warm-espresso shadows (`rgba(33, 28, 25, 0.05–0.18)`), never harsh pure black drop shadows.

---

## 4. Information Architecture & Navigation

### 4.1 Top App Bar (Home)

- **Left**: Transparent `RumaQ` SVG mark (`36px`) + `RumaQ` wordmark + `"Asisten anti boncos in this economy"`.
- **Right**:
  1. **Notifikasi / Pantauan Bell** (`40×40px`, unread `--berry` dot) → Opens **Notifikasi Harga** drawer (with direct shortcut to `"Kelola Pantauan Harga →"`).
  2. **Profil Avatar** (`40×40px`) → Opens **Profil & Pengaturan** sheet (local profile, notification toggles, store settings, about RumaQ).

### 4.2 Bottom Navigation (5 Slots — Large Icons, No Visible Labels)

Icons are **`26×26px`** with `aria-label` + `title` for accessibility and a crisp `--berry` underline pill on the active tab:

| Slot                | View / Action                         | Icon            | Badge                                                                                                |
| ------------------- | ------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| 1                   | **Beranda** (Home)                    | `home`          | —                                                                                                    |
| 2                   | **Brosur** (Brochure Catalog)         | `book`          | —                                                                                                    |
| 3 (Center Elevated) | **Asisten AI** (Character Chat)       | Animated Mascot | Live mood reaction                                                                                   |
| 4                   | **Pantau** (Price Watchlist & Stores) | `bell`          | — _(never show static keyword count badge)_                                                          |
| 5                   | **Daftar** (Shopping Checklist)       | `list`          | **Unchecked items only** (upright `<span>`, `tabular-nums`, drops as items are ticked, hides at `0`) |

- **Rule**: The center elevated button MUST NEVER duplicate Beranda/Search. It launches the **AI Shopping Assistant** from any tab.

### 4.3 Home Screen Vertical Order (Strict)

1. **Top Bar** (Brand + Notifikasi + Profil)
2. **Dark Espresso Search Bar** (`Cari merk atau barang…`)
3. **Hero Savings Card** (`--dark` espresso — the single high-contrast hero anchor on Home):
   - Top: Single full-weekday shopping date trigger (`Sabtu, 28 Nov ▾` → Calendar sheet)
   - Middle: Big savings figure (`Rp` small + tabular digits) + Animated **Ruma** character on right (tappable to chat)
   - Bottom: Actionable jewel pills folding key personal status into one place:
     - **Pantauan** (`N pantauan diskon` or `+ Pantau harga` when empty, `--berry` → opens Pantau tab)
     - **Top Discount** (`Diskon -X%`, `--gold` → opens biggest-discount item)
     - **Daftar Belanja** (`N di daftar`, soft translucent → opens Daftar tab)
4. **`Promo terpopuler`** — **Top 10 products**, **horizontal scroll** (`cards-row`, algorithm-agnostic ranking: views, basket saves, price drop, or hybrid score; uses the exact same `pcard` anatomy with **no rank number badge**) — visible immediately above the fold!
5. **Category Filter Chips** (`Semua`, `Pokok`, `Protein`, `Rumah & Mandi`, `Sayur & Buah`, `Minuman`)
6. **`Promo untukmu`** — **2-column grid, vertical infinite scroll** (`cards-grid`, personalized from watchlist + preferred stores)

> **Why no separate Pantauan card on Home?** Keeping only ONE hero summary anchor avoids visual fatigue, scales cleanly when a user watches 10–30+ items (no cramped keyword list on Home), and pulls the first row of real product cards above the fold. Full watchlist management lives in the dedicated **Pantau** tab.

### 4.4 Unified Mental Model (Never Break)

| Concept              | Indonesian Label      | Icon             | Action                                                                        |
| -------------------- | --------------------- | ---------------- | ----------------------------------------------------------------------------- |
| Add to Shopping List | `Daftar` / `+` → `✓`  | `plus` / `check` | Adds/removes product in **Daftar Belanja**                                    |
| Check off in store   | _(circle tick)_       | `check`          | Marks item as already in physical basket; **auto-sinks to bottom**            |
| Watch price drops    | `Pantau` / `Dipantau` | `bell`           | Adds keyword/brand to **Pantauan Harga** & alerts when relevant promos appear |
| View original flyer  | `Brosur Hal. X`       | `book`           | Opens Brochure sheet directly to that product's page                          |

---

## 5. Component Contracts

### 5.1 Unified Product Card (`pcard`)

Used identically across **Promo terpopuler (Top 10 horizontal)**, **Promo untukmu (vertical infinite scroll)**, **Search**, and **Brochure parsed view** (never add one-off badges like `#1` that break card consistency):

1. **Media (`aspect-ratio: 1.25/1`)**: Full-bleed `object-fit: cover` photo (never letterboxed with `contain`).
   - Top-left badges: Discount pill (`-29%`, `--gold`) + remaining days (`5 hr`, dark translucent).
   - Top-right action: `34×34px` `+` / `✓` button (`data-action="simpan"`).
2. **Body**:
   - Line 1 (Primary): **Brand / Merk** (`15.5px`, `800`, `--dark`, single-line ellipsis).
   - Line 2 (Secondary): Product name + size (`12px`, `600`, `--ink-2`, e.g., `Deterjen Cair · 750 ml`).
   - Line 3 (Price): Promo price (`22px`, `800`, `--berry-deep`, `.rp` at `0.58em`) + strikethrough normal price (`11.5px`, `--ink-3`).
   - Line 4 (Store Footer): Concise pill (`--bg` fill, `--line` border) with `8px` store color dot + store name on left, and **`Termurah`** (`--emerald-soft` / `--emerald-ink`) on right. **NEVER** cram verbose strings like `"-Rp3rb vs 3 toko"` onto cards; put multi-store breakdowns inside the Item Detail Sheet.

### 5.2 Daftar Belanja (Shopping Checklist)

- **Grouping**: Automatically grouped by cheapest supermarket (with per-store item count & subtotal).
- **Auto-Sink Ordering (CRITICAL)**:
  - Within each supermarket group, **unchecked items MUST always sort above checked items**.
  - Supermarket groups that still have unchecked items MUST sort above supermarket groups where all items are already checked.
  - Checked items display strikethrough title, muted `--surface-2` background, and emerald check circle so remaining items stand out effortlessly in the supermarket aisle.
- **Touch-safe delete**: Dedicated visible trash icon button on every row (never hover-only).
- **WhatsApp Share**: One-tap copy/share summary formatted for Indonesian household chat coordination.

### 5.3 Item Comparison Sheet

- Hero image + discount badge → Brand (`h2`) + Name & unit → Emerald Best-Price callout → Unit-price fairness bar (`Setara Rp12.980/kg`) → All-store visual bar comparison with `+Rp...` diff → 3-month price sparkline → Promo validity dates (safe Nov–Dec calendar math!) → 3 equal-clarity actions (`Pantau`, `Daftar`, `Brosur Hal. X`).

### 5.4 Date & Calendar Filter Rules

- **3 filter modes supported**:
  1. **No date filter (`null`)**: `"Semua promo aktif"` — shows all active promos across every date. Users MUST be able to clear the date filter in 1 tap (via `✕` next to the Hero date pill or `"Semua promo aktif"` inside the calendar sheet).
  2. **Single date**: Full Indonesian weekday name ALWAYS (`Sabtu, 28 Nov`, `Rabu, 25 Nov` via `weekday: 'long'`). **NEVER** abbreviate weekdays.
  3. **Date range**: Tap a start date then an end date to show all promos overlapping that window (`promoFrom <= rangeEnd && promoTo >= rangeStart`), with generic quick presets (`Semua promo aktif`, `Hari ini`).
- **Uniform calendar grid**: Always set `table-layout: fixed` and fixed cell button height (`44px`) so labels like `"Hari ini"` or `"Des"` NEVER expand one column larger than sibling date cells.
- **Cross-month safety**: Always construct dates via `new Date(year, monthIndex, daySerial)` so values `> 30` roll accurately into the next month (never render `"34 Nov"`).

### 5.5 Destructive Actions Rule

- Destructive secondary buttons (like `"Hapus semua"` next to `"Salin ke WhatsApp"`) use **soft Berry tint** (`background: var(--berry-soft)`, `border: #F3C4D7`, `color: var(--berry-deep)`) — visually harmonizing with the Berry brand palette while avoiding a loud solid fill that could invite accidental taps over the constructive action.

---

## 6. Iconography Governance

1. **One concept = one icon**:
   - **Bell (`bell`)** is the single consistent icon for **Notifikasi & Pantauan Harga** (header button, Hero Pantauan pill, Pantau tab, and item Pantau button).
   - **Home (`home`)** = Beranda.
   - **Book (`book`)** = Katalog Brosur & Lihat Brosur.
   - **Checklist (`list`)** = Daftar Belanja.
   - **Plus / Check (`plus` / `check`)** = Tambah/Sudah di Daftar.
2. **Stroke consistency**: Uniform `24×24` viewBox, `stroke-width: 2`, `stroke-linecap: round`, `stroke-linejoin: round`.

---

## 7. Copywriting & Tone of Voice (Indonesian Gen-Z / Modern Household)

- **Voice**: Smart, warm, practical, slightly witty — like a savvy friend who always knows where the best deal is.
- **No double headers (no uppercase eyebrows)**: Every view and bottom sheet uses ONE consistent header anatomy: `<h1>`/`<h2>` title + single concise `<p>` subtitle. Never stack redundant uppercase eyebrow labels (`FILTER TANGGAL` above `Pilih tanggal`, `KABAR HEMAT` above `Notifikasi harga`, etc.).
- **Page subtitles describe purpose, not how-to**: Explain _what_ the screen is (e.g., `"Catatan belanjamu, otomatis disusun per supermarket termurah."`), NEVER UI mechanics (`"begitu dicentang otomatis turun ke bawah"`).
- **Algorithm-agnostic copy**: Never hardcode ranking or alert thresholds in UI strings (avoid `"turun ≥10%"`, `"selisih terbesar"`) so backend logic can evolve freely without stale UI copy.
- **Do / Don't Table**:

| Avoid (Cringe / Inaccurate / Verbose / Brittle) | Use Instead                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `"Belanja hemat, keluarga senang"`              | `"Asisten anti boncos in this economy"`                           |
| `"Selamat pagi 👋 Rangkuman promo hari ini..."` | _(Omit greeting; show data directly)_                             |
| `"5 kebutuhan dapur"`                           | `"5 promo pilihan"` / `"barang harian"`                           |
| `"Pilihan pantauan"`                            | `"Promo untukmu"`                                                 |
| `"Selisih harga paling besar"`                  | `"Promo terpopuler"`                                              |
| `"Kabar saat harga turun ≥10%"`                 | `"Kabar promo & turun harga"` / `"begitu ada promo menarik"`      |
| `"Begitu dicentang otomatis turun ke bawah"`    | `"Catatan belanjamu, otomatis disusun per supermarket termurah."` |
| `"Rab, 25 Nov"`                                 | `"Rabu, 25 Nov"`                                                  |
| `"Superindo · -Rp3rb vs 3 toko"`                | `"● Superindo   [Termurah]"`                                      |
| `"Rp64.900"` (same font size for Rp)            | `Rp` (`0.58em`) + `64.900` (`tabular-nums`)                       |

---

## 8. AI Virtual Assistant Character Spec — **Ruma** (Locked)

**Ruma** is RumaQ's official Nusantara AI shopping companion — a direct, cohesive evolution of the RumaQ House-Q + Golden Sparkle logo.

### 8.1 Visual Identity (Nusantara Elements)

- **Body**: Warm golden-amber rounded sparkle spirit (`#FFD464 → #F59E0B`), echoing the golden sparkle inside the RumaQ logo.
- **Headpiece**: Berry-Magenta (`#E01B68 → #A80A47`) curved **Atap Gonjong Nusantara** traditional roof hat crowned with a 4-point golden sparkle ornament.
- **Scarf**: Berry-Magenta neck scarf accented with golden **Batik Kawung** dots.
- **Scale & Placement**:
  - `76–78px` inside the Hero Savings Card (right side, tappable to open AI Chat).
  - `46px` inside the center elevated bottom-nav button (launches AI Chat from any screen).
  - `58px` inside the AI Chat sheet header.

### 8.2 Reactive Animation State Machine

Ruma implements 4 lightweight CSS/SVG states (all disabled cleanly under `prefers-reduced-motion: reduce`):

| State    | Trigger                                                                  | Motion                                         | Expression                            |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------- |
| `idle`   | Default resting state                                                    | Gentle float (`3.2s`) + natural blink (`4.4s`) | Friendly eyes, warm smile             |
| `happy`  | User adds item to Daftar, ticks basket, sets watch, or Ruma finds a deal | Joyful double-hop (`0.55s`) + sparkle burst    | Happy crescent eyes `^ ^`, open smile |
| `search` | User types in Search input                                               | Curious side-to-side peek tilt (`1.1s`)        | Focused eyes leaning toward query     |
| `alert`  | User opens a big-discount product or expiring deal                       | Quick playful wiggle (`0.5s`)                  | Wide excited eyes                     |

---

## 9. Agent Pre-PR UX Verification Checklist

Before opening or approving any frontend UI PR, agents MUST verify:

- [ ] All colors come from Section 3 tokens (no rogue gradients, no legacy teal).
- [ ] Logo uses transparent SVG on web surfaces.
- [ ] Product cards put **Brand (Merk)** first, render smaller `Rp` with `tabular-nums`, and keep store footers to `Store + Termurah`.
- [ ] Day labels use full Indonesian weekday names (`Sabtu, 28 Nov`), and dates crossing month boundaries render correctly.
- [ ] Checked checklist items automatically sink below unchecked items.
- [ ] Touch targets are ≥40px and no action relies exclusively on `:hover`.
- [ ] Bell icon is used consistently for Notifikasi & Pantauan; bottom nav icons are large (`26px`), label-free, with `aria-label` + active indicator.
- [ ] Animations respect `@media (prefers-reduced-motion: reduce)`.
