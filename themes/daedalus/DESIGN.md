# DAEDALUS // DESIGN SYSTEM
## A Hermes Agent dashboard reskin in the spirit of The Designers Republic and Marathon (Kurppa Hosk × Bungie, 2026)

**Codename:** `daedalus`
**Track:** Theme ($350) — primary; Plugin ($600) — stretch
**Built:** 2026‑04‑26 (Hermes Agent Theme Hackathon)
**Author:** Justin Perea

---

## 0. WHY THIS DIRECTION

The default Hermes Teal theme is already polished — soft cream on dark teal, warm amber glow, system fonts. A reskin that nudges hue and swaps fonts reads as the same product in different lighting; the judge skims past it.

The Designers Republic and the Marathon (2026) brand system give us a wholly different vocabulary. They treat the screen as **technical specification**, not editorial layout. Every label is a data tag. Every panel has a serial number, a sector code, a status block. Type is **architectural** — modular blocks built from a unit grid, not letterforms picked from a typeface library. Color is **two‑material** — black and a single saturated radioactive accent — pushed to four when status demands.

Daedalus inherits that vocabulary and bends it onto the operator-facing dashboard of an AI agent. The agent stops being a friendly chat companion and becomes a **system console** — a Sector‑01 readout with a sigil, a faction tag, and a launch latch. That contrast against the soft Hermes Teal default is the point.

---

## 1. INFLUENCES (anchors, not moodboard)

| Source | What we steal | What we leave |
|---|---|---|
| **The Designers Republic** (WipEout, Aphex Twin, PWEI) | Anti-corporate corporate language: TM marks, version numbers, sector codes, "BUILT WITH PURPOSE" stamps. Saturated electric accents on near-black. Hash/stripe dividers. Fake spec-sheet labels everywhere. | Maximalism — TDR is dense; we keep our density at 60% of theirs so the dashboard stays scannable. |
| **Marathon (Kurppa Hosk × Bungie, 2026)** | Faction identity systems. Status banners with bold blocks of color. Industrial product photography composited with brand marks. Recon-shell technical aesthetic. Three-tier font logic (Serif Display + Thick Sans + Rounded Mono). | The maroon-red color story — Hermes Agent's brand identity already lives in dark teal/forest, so we shift to indigo-near-black with a radioactive yellow accent that doesn't compete with the brand's amber glow. |
| **Sekiguchi Genetics (Marathon faction)** | Two‑color discipline. Modular tile letterforms. Bilingual Latin/Japanese label pairs as parallel specification. | The mint-aquamarine — too close to Hermes Agent's existing palette. We use radioactive yellow (`#DCFF00`) instead. |
| **AXION mockups** (user's brand kit) | Page numbering ("02/06"). Top-right corner arrow. Status banner with launch-console button. Engineered-product photography energy. | The 3D product renders — the dashboard has no place for them. We translate that energy into geometric data plates. |

---

## 2. CORE PRINCIPLES

1. **Technical specification, not narrative.** Every label is a callout from a spec sheet. "TOTAL TOKENS" becomes `MTRC.001 // TOTAL TOKENS` with a serial. "Active sessions" becomes `STATUS // SESSIONS·LIVE 0008`.
2. **Two‑material palette with status escalation.** Black + bone white default. Radioactive yellow for primary marks. Cyan for secondary state. Magenta/red only for alerts. Never decorative.
3. **Type as architecture.** Display headlines are extruded (oversized, tight-tracked, square-ended). Body and label are mono. Numerals are tabular. There is no fluffy serif.
4. **Hairlines, not borders.** Cards do not have rounded outlines. They have horizontal rules at top and bottom — like a printed spec card. **No L/R side accent bars** (already a Hermes-brand-system rule).
5. **Every page has a serial.** Sector code top-left, page number top-right (`SEC.01/08`). Status banner under the title. This makes the dashboard feel like a single instrument with eight switchable readouts, not eight loose pages.
6. **Saturated bursts, not gradients.** Solid blocks of color. No CSS gradients on accents. The only gradients allowed: subtle inset card lighting, the warm-glow vignette.

---

## 3. COLOR SYSTEM

### Base (always present)
```
--ink-base       #0A0A0A   /* near-black ground          */
--ink-surface    #111111   /* card / panel surface       */
--ink-elevated   #181818   /* dialogs, popovers, dropdown */
--ink-edge       #1F1F1F   /* hairline alt, hover states  */
--bone           #E8E2D2   /* primary text, body          */
--bone-soft      #ABA395   /* secondary text, captions    */
--bone-faint     #6B6558   /* tertiary, disabled, hint    */
--rule           rgba(232, 226, 210, 0.18)  /* hairline */
--rule-strong    rgba(232, 226, 210, 0.32)
```

### Accent (used sparingly)
```
--rad-yellow     #DCFF00   /* primary mark — links, CTA, active nav, focus ring  */
--rad-yellow-dim #8FA600   /* yellow on dim surfaces (active row backgrounds)    */
--cyan           #4AC4F8   /* secondary — code accents, links-on-hover          */
--magenta        #F84A8C   /* alerts, destructive moments, error spikes         */
--lime           #7FFF7F   /* success, online status, gateway up                */
--blood          #FF3A30   /* CRITICAL — used at most once per page             */
```

### Roles (mapped to Hermes shadcn tokens)
```
primary             = rad-yellow    (CTAs, brand mark, active nav)
primaryForeground   = ink-base      (readable on yellow)
accent              = cyan          (secondary highlights)
secondary           = ink-elevated  (chip backgrounds)
muted               = ink-surface
mutedForeground     = bone-faint
ring                = rad-yellow
border              = rule-strong
success             = lime
warning             = rad-yellow
destructive         = magenta
```

### Discipline rules
- **Yellow is structural material, not a thin accent.** Use it as solid blocks for the load-bearing chrome: top status strip, active nav bar, primary CTAs, default badges, plugin alert banners. Keep yellow *out of* body prose and reading-dense areas — body text and table cells stay on `--bone` over `--ink-base`. Coverage will routinely exceed 8% on action-heavy views; that is intentional.
- **Tri-color discipline by scope.** Yellow + cyan is the default in-component pair (primary + secondary state). Magenta has two roles: (a) **chronic chrome accent** on instrument micro-marks — the sector-eyebrow `///` prefix, the bottom edge of the page frame — to keep the third color visibly part of the system without screaming; (b) **critical state body color** — `[data-priority="critical"]` plates, destructive button/badge fills. Three-color (yellow + cyan + magenta) is allowed at the page-level chrome (frame, header). Inside a single content component, hold the line at two.
- **Solid blocks only.** No fade gradients on accents — no `linear-gradient(yellow, transparent)` washes anywhere. CSS `linear-gradient` *is* allowed as a path-painting technique for solid-stop bands (the L-shaped corner brackets on cards, the hash-mark dividers in §7.3) — the visible result is a flat band, not a fade. Inset shadows on cards are the only acceptable luminance ramp.

### The Yellow Contract (contrast guard)
Any surface that paints `--color-primary` (radioactive yellow) or `--color-destructive` (magenta) as background **MUST** also:
1. Set its own `color` to `--color-primary-foreground` (`#0A0A0A` ink).
2. Force `color: var(--color-primary-foreground) !important` on every `*` descendant.

Step 2 is non-obvious and is the most common bug source. Hermes ships with descendants that carry their own Tailwind text classes — `text-foreground` → bone `#E8E2D2` (renders near-white on yellow → illegible smear) and `text-muted-foreground` → bone-faint `#6B6558` (renders as dark olive on yellow → muddy, also fails contrast). Both failure modes look different but stem from the same omission. The descendant `!important` override is the only reliable defense.

When adding a new strong-color surface to `customCSS`, append the selector to the **CONTRAST GUARD** block in section 16.5 of `daedalus.yaml.template`. Pseudo-element surfaces (`::before`, `::after`) and purely decorative blocks with no text children are exempt. If you're not sure, list it anyway — the rule is idempotent.

This contract was discovered after the example plugin's `<span class="text-muted-foreground">` rendered as bone-on-yellow inside the `SESSIONS:TOP` banner.

---

## 4. TYPOGRAPHY

Three font families, one numeric scale. Every type value lives as a CSS custom property in the `:root` token block at the top of `customCSS` (section 0.0). **Reach for tokens, never inline numbers.** Snapping a stray value to the nearest token is preferable to widening the system.

### Families
| Tier | Family | Weights | Used for |
|---|---|---|---|
| Display | Geist Mono Bold | 800 / 900 | Page H1, in-body H2, hero metrics |
| Body | IBM Plex Sans | 400 / 500 / 600 | Prose, table data, form values |
| Mono | IBM Plex Mono | 400 / 500 / 600 / 700 | Every label, sector code, badge, button, nav, table header, code, timestamp, ticker |
| JP | Noto Sans JP | 400 / 500 | Bilingual katakana sub-labels (Sekiguchi-Genetics homage) |

### Type scale
| Token | Value | Used for |
|---|---|---|
| `--type-stamp` | 8px | Sigil credit (`DAEDALUS · v1.0`), katakana sub-labels, `MTRC ░░` card serial |
| `--type-eyebrow` | 9px | Top status strip, sector eyebrow, page indicator, footer ticker, table headers, badges, recharts axis text |
| `--type-micro` | 11px | Sidebar nav, button text, plugin banners, chart tooltip, code blocks, input fields, table cells, tabs |
| `--type-body` | 14px | Card title, body prose, default Hermes body |
| `--type-h2` | 32px | In-body H2 (section headers inside content), hero card title |
| `--type-metric` | 48px | Card metric numerals (the "5.3M / 87.6 / 128.4K" tabular numbers) |
| `--type-display` | 56px | Page-header H1 (the poster headline at the top of every route) |

The scale is irregular by design — large gap between `body` (14) and `h2` (32) keeps display headlines from competing with mid-weight content. **No tier between body and h2 is allowed.**

### Tracking scale
| Token | Value | Applied to |
|---|---|---|
| `--track-display` | -0.03em | H1, page-header H1, hero metric numerals |
| `--track-tight` | -0.02em | H2, `.font-expanded` Hermes utility |
| `--track-label` | 0.18em | Sidebar nav, recharts text, body labels, nav counter prefix |
| `--track-control` | 0.22em | Buttons, badges, banners, tabs, priority callouts |
| `--track-eyebrow` | 0.32em | Top status strip, sector eyebrow, page indicator, footer ticker, table thead, MTRC card serial |

H3 / card-title (14px Geist Mono) renders at `letter-spacing: 0` — a deliberate "no tracking" slot for content titles inside cards, distinct from the chrome's spaced labels.

### Line-height scale
| Token | Value | Applied to |
|---|---|---|
| `--lh-display` | 0.9 | H1, page-header H1 (extruded tight) |
| `--lh-tight` | 1.0 | H2, H3, mono labels, metric numerals |
| `--lh-body` | 1.4 | (Reserved — body prose default) |
| `--lh-prose` | 1.55 | Long-form prose (set on Hermes runtime via `typography.lineHeight`) |

Pixel line-heights (`22px` on the status strip, `26px` on the footer ticker) are intentional **layout constants** matching the strip/ticker heights for vertical centering — not part of the typographic scale.

### Forbidden (hard rule)
- No serif. Period. (The atelier-Cormorant direction is dead.)
- No Inter. No Roboto. No Helvetica.
- No italics — except the *literal italic* of an inline `i` tag in user prose; system never sets text in italic.

### Bilingual / spec labels (signature pattern)
Pair the English label with a Japanese katakana micro-line below. Aesthetic only — Sekiguchi-Genetics homage. Used on hero stats and faction-tagged sections.
```
TOTAL TOKENS         <-- IBM Plex Mono --type-eyebrow tracked --track-eyebrow
トータルトークン      <-- Noto Sans JP --type-stamp
4,860,920,000        <-- Geist Mono Bold (--type-h2 or --type-display) tabular
```

### Font loading
One Google Fonts request loads everything (Geist Mono / IBM Plex Sans / IBM Plex Mono / Noto Sans JP). URL embedded in `typography.fontUrl`.

---

## 5. LAYOUT & GEOMETRY

### Spacing scale (4-base grid)
Every padding / margin / gap value lives as a CSS custom property. Off-grid values are not allowed; if a layout calls for `18px`, snap to `--space-4` (16) or `--space-5` (20).

| Token | Value | Typical use |
|---|---|---|
| `--space-1` | 4px | Hairline detail (badge vertical padding, inline code padding, nav counter margin) |
| `--space-2` | 8px | Inline padding on small marks (badge horizontal, sidebar bottom breath, scrollbar width) |
| `--space-3` | 12px | Default vertical control padding (nav, button, table cell, plugin banner, priority callout) |
| `--space-4` | 16px | Default horizontal control padding (table cell, banner, priority callout) |
| `--space-5` | 20px | Wide horizontal padding (nav, tabs, page padding compact) |
| `--space-6` | 24px | Page header top padding, page padding default |
| `--space-8` | 32px | Page header horizontal padding, page padding spacious |
| `--space-9` | 36px | (Reserved — large block separation) |

### Layout constants (intentionally not on the spacing scale)
A few pixel values are functional, not stylistic, and remain inline:
- `padding-top: 22px` on `<body>` — matches the top status-strip height.
- `padding-bottom: 32px` on `<body>` — matches footer ticker (26px) + corner-bracket bottom (2px) + breathing room.
- `line-height: 22px` / `26px` on the status strip / footer ticker — vertical centering at strip height.
- `max-height: calc(100dvh - 54px)` on `aside#app-sidebar` — fits within body content area (22 top + 32 bottom).

These are documented at their site of use with `LAYOUT CONSTANT` comments. Do not refactor to tokens — the value's job is to track another value, not to express design intent.

### Other geometry
- Sidebar width: **240px** (matches Hermes default — managed by Hermes layout).
- All component corners: **radius 0**. No exceptions, no soft pills.

### Page structure (each Hermes route)
```
┌─ SECTOR HEADER ──────────────────────────────────────────────────┐
│  SEC.01 // SESSIONS  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  PG 01/08 ↗ │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─ PAGE TITLE ─────────────────────────────────────────────┐   │
│   │  SESSIONS              [BADGE: 0058]                       │   │
│   │  the operator's open conversation pool.                    │   │
│   │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│   [STATUS BANNER (only when something is happening)]             │
│   [METRIC PLATES — 2 to 4 across]                                │
│   [PRIMARY READOUT — chart, table, or list]                      │
│                                                                  │
└─ FOOTER STAMP ──────────────────────────────────────────────────┘
   DAEDALUS // ATELIER · BUILT WITH PURPOSE · v1.0 · MMXXVI
```

### Hairlines
- One single hairline rule between sectors. Never double-bordered.
- Hash-mark divider variant for major page changes: `━━━━ ░░░░ ━━━━` (dashes, density-mark, dashes). Used in customCSS as a `::before` on `<hr>`.

### Asymmetric balance
- Page-title block is left-aligned. Page number is right-aligned. Always.
- Status banners run full-width.
- Metric plates align left in their grid, with the eyebrow label flush-left, the metric flush-left, units in mono right-aligned.

---

## 6. COMPONENT VOCABULARY

### 6.1 // Sector Header (top of each page)
- Stripe of `--ink-surface` height 28px, full-width.
- Left: sector code in mono caps `SEC.01 // SESSIONS`.
- Right: page indicator + arrow `PG 01/08 ↗`.
- Hairline rule below.

### 6.2 // Page Title block
- Display H1, uppercase, tight tracking.
- Right-aligned mono badge on the same row showing the running count (e.g. session count).
- One-line description below in IBM Plex Sans 14px, `--bone-soft`.
- Hairline rule under the description.

### 6.3 // Status Banner
- Full-width strip 40px tall, inserted ONLY when there's a state to communicate.
- Left: 28×28 colored block (yellow/cyan/magenta/lime/blood depending on state).
- Adjacent: mono caps label `STATUS // GATEWAY ONLINE` or `ALERT // RATE LIMIT NEAR THRESHOLD`.
- Right: action button if applicable, in `[ LAUNCH CONSOLE ↗ ]` plate.

### 6.4 // Metric Plate (the readout card)
- `--ink-surface` background, hairline top + bottom (no L/R borders).
- 3px `--rad-yellow` inset stripe along the top edge (the "live" mark).
- 18×18 solid corner block at top-right — the "active filament" mark. Color rotates by sibling position via `:nth-of-type(4n+N)`: yellow → cyan → magenta → lime. Tri-color presence across long card lists.
- Eyebrow: mono caps `--type-eyebrow` + `--track-eyebrow` tracking, e.g. `MTRC.001 // TOTAL TOKENS`.
- Optional bilingual line below: katakana `--type-stamp`.
- Metric: Geist Mono Bold `--type-metric` (48px) tabular numeric, color `--bone`.
- Sub-metric: mono `--type-micro`, `--bone-soft`, with delta arrow `▲ 5.4%` colored by direction.
- `MTRC ░░` mono-caps serial stamp, bottom-right, `--bone-faint` tracked.
- Hover: faint yellow tint (`rgba(220, 255, 0, 0.06)`) on the card background.

**Why no auto-hero variant**: an earlier version made the first card in any sibling group (`:first-of-type`) into a solid yellow plate. It looked great on Analytics (where the first card is genuinely a metric summary) but broke every other page — on Cron / Skills / Config the first card is the *primary content container* (a form, a filter panel, a config editor), and painting yellow buried the input fields. CSS has no way to distinguish "metric summary" from "primary content" without a Hermes-side semantic discriminator. Removed in v6i. If/when Hermes adds an attribute hook for the metric-card pattern, the hero treatment can be reinstated.

### 6.5 // Data Table
- Header row: mono caps 9px tracked +0.22em, `--bone-faint`, hairline-strong below.
- Body rows: IBM Plex Mono 12px, hover state = `--ink-edge`.
- Zebra-stripe disabled. Use single hairline between rows at `--rule-soft`.
- Faction tags inline: `[RECON]` `[FREEBACK]` style mono pills, colored by classification.

### 6.6 // Chart
- Recharts grid → 1px dashed `--rule` (`stroke-dasharray: 1 3`).
- Bars → `--bone` for input (series 1), `--magenta` for output (series 2). Forced via `!important` because recharts applies inline `fill` attributes that beat normal CSS. The bone+magenta pairing keeps yellow reserved for primary chrome and gives charts their own tri-color presence.
- Area charts → solid fill `rgba(220, 255, 0, 0.10)` under a 1.5px `--rad-yellow` stroke.
- Tooltip → mono `--type-micro` on `--ink-elevated`, hairline border.
- Legend → bottom-left, mono caps with a small ▪ swatch instead of a dot.

### 6.7 // Button
- **Default**: solid `--rad-yellow` fill, ink text (per Yellow Contract), no border, mono caps, +0.20em tracking, square corners. Reads as a yellow plate — the loud move.
- **Hover (default)**: fill swaps to `--bone`, text stays ink. Inverts.
- **Ghost**: transparent fill, `--bone` text. Hover → solid yellow fill, ink text.
- **Outline**: 1px `--rad-yellow` border, transparent fill, yellow text. Hover → solid yellow fill, ink text.
- **Destructive**: solid `--magenta` fill, ink text (Yellow Contract applies — magenta is also a strong-color surface).
- Default + outline buttons render text wrapped in brackets at the design layer: `[ EXECUTE ]`. Implemented via `::before/::after`.

### 6.8 // Input / Textarea
- `1px solid --rule` border, transparent fill.
- Focus: border `--rad-yellow`, 1px outer ring `--rad-yellow-dim`.
- Mono 12px placeholder, italic-style suppressed.

### 6.9 // Badge
- **Default**: solid `--rad-yellow` fill, ink text (per Yellow Contract), no border, mono caps 9px tracked. Used to mark counts and live state.
- **Outline / secondary**: 1px `--rad-yellow` border, transparent fill, yellow text.
- **Destructive**: solid `--magenta` fill, ink text.

### 6.10 // Sidebar
- `--ink-surface` background, hairline right-edge inset.
- Brand block top: keeps the original `HERMES AGENT` wordmark restyled in Geist Mono Bold (we restyle, never rename — see §7.1). A small `DAEDALUS · v1.0` credit pinned bottom-right of the block is the only place the chrome names the theme.
- Nav items: mono caps 11px, `--bone-soft` default. Active = `--rad-yellow` text + `◆` ornament left.
- Footer block: SYSTEM stats — gateway state, active session count.

### 6.11 // Modal / Dialog
- `--ink-elevated` background, hairline border at `--rule-strong`.
- Title in display H2.
- Content in body sans.
- Action row at bottom hairline-separated.

### 6.12 // Watermark
- Faint 180×220 cyanotype hermes-figure portrait fixed bottom-right.
- Opacity 0.07, mix-blend-mode `screen`.
- Hidden < 1024px viewport.

---

## 7. SIGNATURE ELEMENTS (the "DAEDALUS-only" marks)

### 7.1 // Sidebar brand block
The product name `HERMES AGENT` stays — Daedalus is a theme, not a rename. We restyle the wordmark, never relabel it.
- Wordmark in Geist Mono Bold, uppercase, tracked tight (+0.04em).
- A `DAEDALUS · v1.0` theme credit pinned bottom-right of the brand block in IBM Plex Mono 9px `--bone-faint`, tracked +0.20em — the single place the theme self-identifies in the chrome.
- The cyanotype sigil (5KB JPEG, embedded as `assets.custom.sigil` data URL) is retained for future use as a watermark (§6.12) but is **not** rendered in the sidebar in v1.0.

### 7.2 // The page-corner arrow
Top-right of every sector header: `↗` glyph at 14px in `--rad-yellow`. A constant — like the AXION brand kit.

### 7.3 // Hash-mark dividers
Used between major sections of the docs page or long lists.
```
━━━━━━━━━━━━━━━━━━━━━━━━░░░░░░░░░░━━━━━━━━━━━━━━━━━━━━━━━━━
```
Implemented as repeating-linear-gradient on a 1px hr.

### 7.4 // Status filaments
Small 4px tall colored bars that light up at the top of cards reflecting agent state. **Idle = absent** (no filament — yellow is the focus tool, not the resting state, so nothing lit means nothing happening). Lime = running, cyan = waiting, magenta = error, blood = critical. Animated only on state change (200ms fade-in). Otherwise static.

### 7.5 // Footer stamp
Bottom of every page (or the app footer row):
```
DAEDALUS // ATELIER · BUILT WITH PURPOSE · ENGINEERED TO ELEVATE · v1.0 MMXXVI
```
Mono 9px, `--bone-faint`, tracked +0.18em. Center-aligned. Hairline above.

### 7.6 // Faction tags
Small mono-caps pills used to classify table rows or cards. Eight registered factions:
```
[RECON]    cyan
[FREEBACK] yellow
[ATELIER]  bone (default)
[CRON]     lime
[KEYS]     magenta
[SKILL]    yellow-dim
[LOG]      bone-soft
[ALERT]    blood
```

### 7.7 // Bilingual specification line
On hero metric plates, a Japanese katakana subtitle 8px below the English eyebrow label. Purely aesthetic. Renders even with a system font fallback if Noto JP fails to load.

---

## 8. ICONOGRAPHY

- Hermes Agent dashboard ships with a small set of mapped icons (`Activity`, `BarChart3`, `Clock`, `Code`, etc. — see plugin SDK docs).
- We don't replace the icon set — instead we **mute** it: `1px stroke`, color `--bone-soft` default, `--rad-yellow` active, no fill.
- Add the diamond ornament `◆` and `◇` as text glyphs for active markers, list bullets, and ornament punctuation.

---

## 9. MOTION

Static-by-default is the rule. We're an instrument, not a slideshow.

| Element | Motion |
|---|---|
| Page load | Single 180ms fade for content. No staggered reveals. |
| Status banner appearance | 200ms slide-down + fade. |
| Status filament color shift | 240ms cubic-bezier(0.4, 0, 0.2, 1). |
| Hover states | 120ms color/border transition. No transform. |
| Button press | 80ms inset shadow on the click moment. |
| Modal open | 200ms scale 0.96 → 1 + fade. |

No bouncing, no spring physics, no parallax, no animated charts, no shimmer except for `data-loading="true"` skeletons (180ms gradient sweep).

---

## 10. VOICE & MICROCOPY

The dashboard speaks like the back of a piece of factory equipment. Concise, instrumental, capitalized labels, mostly nouns.

- "Run agent" → `EXECUTE`
- "Sessions" → `SESSIONS // 0058`
- "View" → `INSPECT ↗`
- "Cancel" → `ABORT`
- "Settings" → `CONFIG`
- "Documentation" → `MANUAL`
- "Logs" → `TELEMETRY`
- Empty states: `// NO TELEMETRY ENGAGED · INITIATE A SESSION`

User-facing prose stays in body sans, sentence case. System-level chrome stays in mono caps. Two registers, sharply separated.

---

## 11. IMPLEMENTATION PLAN

### Track A — Theme YAML ($350 track)
Lives at `themes/daedalus/theme/daedalus.yaml`. Single self-contained file, no external assets.

| What | Where | Done? |
|---|---|---|
| Palette tokens | `palette` + `colorOverrides` | Done (v5g) — black + radioactive yellow |
| Typography stack | `typography.fontSans/Mono/Display` + `fontUrl` | Done (v5g) — Geist Mono + IBM Plex Sans/Mono via one Google Fonts URL |
| Layout | `layout.radius: 0`, `density: comfortable` | Done |
| Component chrome | `componentStyles.card/header/sidebar/footer/badge` | Done (v5g) — per §6 (with shipped deviations now folded back into §6) |
| Sigil watermark | `assets.custom.sigil` (data URL) | Done — retained, not currently rendered (§7.1) |
| customCSS | Typography, signature elements, charts, contrast guard | Done (v5g) — 22KB / 32KB cap |

### Track B — Plugin ($600 track) — stretch
Lives at `themes/daedalus/dashboard/`.

If we have time tonight:
1. Register a `manifest.json` with `tab.override = "/analytics"` so we replace the built-in Analytics page with a Daedalus-styled custom layout.
2. Build the page with the SDK — `Card`, `Badge`, `Tabs` — composed into our metric-plate / status-banner / chart vocabulary.
3. Add a `header-banner` slot that injects the SECTOR HEADER strip on every page.
4. (Optional) Add `plugin_api.py` that surfaces a custom `/api/plugins/daedalus/sectors` endpoint returning the page sector mapping.

If we run out of time, skip Track B and ship Track A solo.

### Track C — Documentation
- This file (`DESIGN.md`) is the design system spec.
- `README.md` at repo root: how to install, screenshots, link to design.md.
- `LICENSE`: MIT (or AGPL to match nebula_nodes — let user decide).
- Two screenshots minimum (default vs daedalus comparison).

---

## 12. SUBMISSION CHECKLIST

- [x] `themes/daedalus/theme/daedalus.yaml` finalised per §6, §7 (v5g)
- [x] Installed locally to `~/.hermes/profiles/hephaestus/dashboard-themes/` AND `~/.hermes/dashboard-themes/`
- [x] Visually QA'd against §6 page structure (Sessions page + plugin banner contrast pass)
- [ ] (Optional) Plugin scaffold under `themes/daedalus/dashboard/`
- [ ] Screenshots: `screenshots/01-sessions.png`, `02-analytics.png`, `03-logs.png`
- [ ] `README.md` with install instructions
- [ ] `LICENSE`
- [ ] Repo pushed to GitHub (public, open-source per contest rules)
- [ ] Discord submission posted with repo link + screenshots

---

## 12.5 SELECTOR STABILITY TIERS

The theme talks to Hermes through three layers, each with a different stability guarantee. When updating the theme, know which tier you are touching.

### Tier 1 — Stable (documented surface)
These survive Hermes updates because they are part of the published theming contract:
- **Theme YAML blocks**: `palette` (3-layer + warmGlow), `typography`, `layout`, `assets`, `componentStyles` (buckets: card, header, footer, sidebar, tab, progress, badge, backdrop, page).
- **Generated CSS vars**: `--color-*` (auto-derived from palette), `--component-<bucket>-<kebab>` (from componentStyles), `--theme-asset-<name>`.
- **Documented attributes**: `:root[data-layout-variant="cockpit"]` etc.

Prefer these. Adding a new color? Edit `palette` or `colorOverrides`. Tuning a card's background? Edit `componentStyles.card`.

### Tier 2 — Semi-stable (standard web platform)
These are Hermes-agnostic — they target standard HTML / ARIA / well-known third-party libraries:
- **HTML tags**: `h1`, `h2`, `h3`, `body`, `html`, `main`, `aside`, `header`, `nav`, `table`, `code`, `pre`, `input`, `button`, `div`, `a`.
- **ARIA**: `aria-current="page"` (for active nav), `aria-hidden`, `role="banner"`.
- **IDs from Hermes layout**: `aside#app-sidebar` (the sidebar root — stable enough to rely on).
- **Recharts classes**: `.recharts-bar`, `.recharts-bar-rectangle`, `.recharts-cartesian-grid`, `.recharts-default-tooltip`, `.recharts-text`, etc. — third-party library, very stable.
- **Pseudo-elements**: `html::before`, `html::after`, `body::before`, `body::after`, `*::-webkit-scrollbar`, `::selection`, `::placeholder`, `::before/::after` on tag selectors.

These are highly likely to keep working but require a maintainer to react if Hermes restructures markup or upgrades recharts.

### Tier 3 — Fragile (Hermes implementation detail)
These target Tailwind class substrings on Hermes' shadcn fork. They are **not part of any documented contract** — Hermes could rename a class on any release and these selectors would silently go dead. The theme degrades to "Hermes default with our palette" rather than visibly breaking.

Each Tier 3 selector in `customCSS` is annotated with the comment `FRAGILE — see DESIGN.md "Selector stability tiers"`. Live targets:
- `button[class*="gap-2"][class*="font-mondwest"]` and `[class*="bg-foreground/90"]` etc. — Buttons (variants).
- `div[class*="font-compressed"]` and variant qualifiers — Badges.
- `input[class*="font-courier"]` — Inputs.
- `button[class*="relative"][class*="font-mondwest"][class*="px-3"]` — TabsTrigger.
- `[class*="text-card-foreground"]` — Cards.
- `.font-expanded`, `.font-mondwest`, `.font-courier`, `.font-serif`, `.border-dashed`, `.text-3xl/4xl/5xl` — Hermes utility classes consumed by multiple components.

When Hermes ships an update, the first thing to check after a visual regression is: did any Tailwind class names change? Inspect a Hermes element in the browser and compare against the selectors here. If a class moved, update the selector — don't rewrite the rule.

### What we asked Hermes for (future work)
A single-PR upstream contribution to add `data-slot` and `data-variant` attributes to the shadcn components (Button, Badge, Input, TabsTrigger, Dialog, Card) would let theme authors write `[data-slot="button"][data-variant="default"]` instead of class-substring chains. This would promote everything currently in Tier 3 to Tier 1. The PR is small and idiomatic shadcn practice.

---

## 13. DECISIONS LOCKED (don't relitigate)

- Direction = **Daedalus / TDR-Marathon**, not cyanotype-atelier. Atelier was scrapped after default-vs-daedalus screenshot showed it was a tonal nudge, not a re-skin.
- Primary accent = **radioactive yellow `#DCFF00`**, not amber. Amber lives in default Hermes, would compete.
- Background = **near-black `#0A0A0A`**, not indigo. Indigo was too close to the default teal in luminance.
- Typography = **Geist Mono Bold + IBM Plex Sans + IBM Plex Mono**. Cormorant is dead.
- Watermark = **keep** the 5KB cyanotype sigil — it's a 7KB base64 cost for a load-bearing brand element.
- License = **MIT**, default unless user overrides — contest requires open source.
- The contest deadline may have already passed (Eastern time, midnight PST has come and gone). We push anyway — this becomes a finished portfolio piece either way.

---

*EOF · DAEDALUS // DESIGN SYSTEM · v1.0 MMXXVI*
