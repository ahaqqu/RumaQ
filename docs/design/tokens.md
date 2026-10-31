# RumaQ redesign — design language (distilled from Figma)

Extracted 2026-10-31 from the Figma export of the Desktop Home app shell
(`docs/design/figma-desktop-home-shell.css.txt`) and the Home mockups
(desktop + mobile). This replaces the old blue oklch palette of the current app.

## 1. Color palette

| Role              | Hex                               | Used for                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page background   | `#F7F7F0`                         | App canvas (warm off-white)                                                                                                                                                                                                                                      |
| Surface / cards   | `#FFFFFF`                         | Sidebar, header, cards, buttons                                                                                                                                                                                                                                  |
| Border (hairline) | `#E2E6DC`                         | Card borders, dividers, sidebar edge                                                                                                                                                                                                                             |
| **Primary green** | `#245C43`                         | Brand, wordmark, selected nav, primary buttons, links, icons on tint                                                                                                                                                                                             |
| Soft green tint   | `#E9F0E5`                         | Selected nav fill, connectivity banner, status chips, secondary buttons, empty-state illustration tile                                                                                                                                                           |
| Inset tile        | `#F0F2EA`                         | Household selector, account avatar tile                                                                                                                                                                                                                          |
| Text primary      | `#20352C`                         | Headings, nav labels (dark green-charcoal)                                                                                                                                                                                                                       |
| Text muted        | `#69756C` → **`#5F6B62` in code** | Secondary copy, unselected nav, helper text. The Figma value measures 4.47:1 on the page background (4.26:1 on inset tiles) — just under WCAG AA — so the shipped token is darkened one step to `#5F6B62` (≥4.76:1 everywhere). Update the Figma style to match. |
| On-primary        | `#FFFFFF`                         | Labels/icons on primary green                                                                                                                                                                                                                                    |

Urgency colors (Critical / Low soon) shown in the mockups as red / amber badge
tints — exact hexes not yet exported; propose `#B3261E`-family red tint and
`#8A5A0B`-family amber tint on soft backgrounds, to be confirmed from Figma.

## 2. Typography — Inter

| Style                               | Spec                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| Wordmark                            | 27px / 33px · 700 · -1px tracking · green            |
| Page title (greeting)               | 34px / 41px · 600 · -1px tracking                    |
| Empty-state title                   | 23px / 125% · 600 · centered                         |
| Nav destination                     | 14px · 600 selected (green) / 500 unselected (muted) |
| Body copy                           | 14px / 145%                                          |
| Secondary copy                      | 12px / 145%                                          |
| Breadcrumb / banner text            | 12px · 400                                           |
| Micro group label (HOUSEHOLD ADMIN) | 10px / 12px · 600 · +1px tracking · uppercase        |
| Status chip label                   | 11px · 600                                           |
| Links / small actions / logout      | 13px                                                 |
| Account name / role                 | 14px 600 / 12px 400                                  |

## 3. Radius

| Element                                  | Radius              |
| ---------------------------------------- | ------------------- |
| App frame                                | 20px                |
| Cards (getting-started)                  | 18px                |
| Primary button, nav rows, banners, chips | 10px                |
| Household selector, account tile         | 12px                |
| Empty-state illustration tile            | 28px (on 88px tile) |
| Assistant dock                           | 100px (pill)        |
| Brand mark                               | 11px (on 36px tile) |

## 4. Spacing & layout

- **Sidebar:** 240px wide · padding 24 · vertical block gap 32.
- **Nav row:** height 46 · padding 12 · icon 21px · icon–label gap 12.
- **Header:** height 88 · side padding 36 · breadcrumb 12px over current-date 14px/500 · right actions gap 20.
- **Connectivity banner:** height 36 · side padding 36 · soft-green fill · icon 15px + 12px text.
- **Content:** padding 36 · section gap 26 · content width 1200 at 1440 frame.
- **Getting-started cards:** padding 16 · inner gap 10 · row gap 24 · equal widths (flex-grow).
- **Empty state:** 88px illustration tile, 24px top padding, 20px gap, full-width 480px action button (48px tall), helper line 12px.
- **Assistant dock:** bottom-right, 20px bottom inset, 36px right inset; pill 46px tall.

## 5. Components (observed specs)

- **Sidebar destination:** icon 21 + label 14; selected = `#E9F0E5` fill, `#245C43` 600 label, 5px green dot marker; unselected = white fill, `#69756C` 500.
- **Primary action:** `#245C43` fill, white 600 14px label, icon 19px, radius 10, height 48.
- **Secondary action:** `#E9F0E5` fill, green 600 14px label, radius 10.
- **Status chip:** soft-green pill (4×8 padding), 12px icon + 11px 600 green label.
- **Connectivity banner:** soft-green full-width bar, cloud-check icon, 12px green text.
- **Empty state:** centered column — 88px soft-green tile (28px radius, 38px green icon), 23px 600 title, 14px muted desc, full-width soft-green action with arrow icon, 12px helper line.
- **Account block:** 40px inset tile (12px radius, 20px user icon) + 14px 600 name + 12px muted role; logout row below (13px muted + 18px icon).
- **Floating AI assistant:** white pill, 1px `#245C43` border, sparkles 19px, 13px 600 green label, bottom-right dock.

## 6. Icon set — Lucide (replaces Phosphor)

Confirmed in export: `sprout` (brand), `house`, `package`, `calendar-days`,
`receipt-text`, `chart-no-axes-combined`, `settings`, `sliders-horizontal`,
`users`, `user-round`, `log-out`, `scan-line`, `cloud-check`, `check`,
`arrow-right`, `sparkles`. 1px stroke; 19–21px in nav/buttons, 12–15px in chips/banners.

## 7. Notes for implementation

- The export is from the **empty-state Home variant** — it also gives us the
  onboarding pattern (empty destination + 3-card "getting started guide").
- Sidebar contains the "Member management" admin link → matches issue #331.
- Dark mode: not designed yet — palette is light-only.
- Old tokens (`frontend/src/styles.css` oklch blue theme) must be replaced by
  these values during the rewrite; persona theming will need re-mapping onto
  the new green hue (230 → ~150 hue family).
