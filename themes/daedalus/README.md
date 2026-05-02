# DAEDALUS

> A **Hermes Agent** dashboard theme in the visual language of **The Designers Republic** and **Marathon** (Kurppa Hosk × Bungie 2026).

Near-black ground. Bone parchment text. Radioactive yellow as structural material — not accent. Magenta and cyan as instrument micro-marks. Geist Mono Bold + IBM Plex. Square corners, hairline rules, mono-caps everywhere. The agent stops being a friendly chat companion and becomes a **system console**.

Built for the Hermes Agent Theme Hackathon (Nous Research, April 2026).

---

## SCREENSHOTS

> _Add screenshots in `screenshots/`. Suggested set: `01-sessions.png`, `02-analytics.png`, `03-config.png`._

```
screenshots/
├── 01-sessions.png    — sessions list, nav numbering, page header
├── 02-analytics.png   — metric cards, daily token chart (bone + magenta)
└── 03-config.png      — config panel on a content-heavy page
```

---

## INSTALL

Daedalus is a single self-contained YAML theme. It works with Hermes Agent v0.11.0+.

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/JustinPerea/Republic/main/theme/daedalus.yaml \
  -o ~/.hermes/dashboard-themes/daedalus.yaml
```

If you use Hermes profiles (`~/.hermes/profiles/<name>/`), copy to that profile's `dashboard-themes/` directory instead — Hermes is profile-aware via `~/.hermes/active_profile`.

### Manual install

1. Download [`theme/daedalus.yaml`](theme/daedalus.yaml).
2. Place it in **either** of these locations:
   - `~/.hermes/dashboard-themes/daedalus.yaml`
   - `~/.hermes/profiles/<active-profile>/dashboard-themes/daedalus.yaml`
3. Restart the Hermes dashboard, or hit the rescan endpoint:
   ```bash
   curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
   ```
4. Open the dashboard, pick **Daedalus** from the theme selector.

### Belt-and-suspenders install

If you want the theme to apply regardless of which profile is active, install it in both locations:

```bash
THEME_URL="https://raw.githubusercontent.com/JustinPerea/Republic/main/theme/daedalus.yaml"
curl -fsSL "$THEME_URL" -o ~/.hermes/dashboard-themes/daedalus.yaml
mkdir -p ~/.hermes/profiles/$(cat ~/.hermes/active_profile 2>/dev/null || echo default)/dashboard-themes
curl -fsSL "$THEME_URL" -o ~/.hermes/profiles/$(cat ~/.hermes/active_profile 2>/dev/null || echo default)/dashboard-themes/daedalus.yaml
```

---

## DESIGN SYSTEM

The full design system lives in [`DESIGN.md`](DESIGN.md). Highlights:

- **Color**: 3-layer black/bone/yellow base + cyan secondary + magenta tertiary + lime success. Yellow is structural material. Magenta + cyan are chronic chrome accents (`/// SEC` eyebrow, page indicator, frame bottom edge). [Yellow Contract](DESIGN.md#the-yellow-contract-contrast-guard) — strong-color surfaces force ink descendants.
- **Type**: Geist Mono Bold (display) + IBM Plex Sans (body) + IBM Plex Mono (every label). [Token-based scale](DESIGN.md#typography) — 6 type sizes, 5 trackings, 4 line-heights. Reach for `--type-eyebrow` instead of `font-size: 9px`.
- **Spacing**: 4-base grid (`--space-1` through `--space-9`). Layout constants (status-strip height, ticker height) deliberately stay numeric.
- **Components**: cards with yellow top stripe + color-rotating corner block (yellow → cyan → magenta → lime); buttons as solid yellow plates with `[ EXECUTE ]` brackets; badges as yellow stamps; numbered sidebar nav with cyan counters; magenta `/// SEC` page eyebrow.
- **Signature elements**: top status strip running `HERMES AGENT ⌬ STATUS·OPERATIONAL ⌬ ...`, corner-bracket frame (yellow top + sides, magenta bottom), registration `+` marks scattered on the content area, mono footer ticker.

### Selector stability tiers

The theme talks to Hermes through three layers with different upgrade-resilience guarantees. Documented in [`DESIGN.md` § 12.5](DESIGN.md#125-selector-stability-tiers). Short version:

- **Tier 1** (stable): `palette` / `componentStyles` / generated CSS vars. Survives Hermes updates.
- **Tier 2** (semi-stable): standard HTML / ARIA / `aside#app-sidebar` / `header[role="banner"]` / pseudo-elements.
- **Tier 3** (fragile): Tailwind class substrings on Hermes' shadcn fork (`button[class*="gap-2"]` etc.). Could break on any Hermes update; theme degrades to "Hermes default with our palette" rather than visibly breaking.

Each Tier 3 selector in `theme/daedalus.yaml.template` is annotated `FRAGILE — see DESIGN.md`.

---

## CUSTOMIZATION

The shipped `theme/daedalus.yaml` is generated from `theme/daedalus.yaml.template` (which has the sigil image embedded as a base64 placeholder). To regenerate after tweaks:

```bash
python3 - << 'PYEOF'
import base64
sigil_b64 = base64.b64encode(open('assets/sigil.jpg', 'rb').read()).decode('ascii')
data_url = f"data:image/jpeg;base64,{sigil_b64}"
template = open('theme/daedalus.yaml.template').read()
open('theme/daedalus.yaml', 'w').write(template.replace('__SIGIL_DATA_URL__', data_url))
PYEOF
```

The `customCSS` block is capped at 32 KiB by Hermes. Daedalus ships at ~29 KiB.

---

## INFLUENCES

- **The Designers Republic** — anti-corporate corporate language, sector codes, "BUILT WITH PURPOSE" stamps, saturated electric accents on near-black.
- **Marathon (Kurppa Hosk × Bungie, 2026)** — faction identity systems, status banners with bold blocks of color, three-tier font logic.
- **Sekiguchi Genetics** (Marathon faction) — two-color discipline, modular tile letterforms, bilingual Latin / katakana label pairs.
- **AXION brand kit** mockups — page numbering, top-right corner arrow, status banner with launch-console button.

---

## LICENSE

[MIT](LICENSE). Use, modify, fork, ship.

## CREDITS

Built by [Justin Perea](https://justinperea.com) for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) Theme Hackathon, April 2026.

`DAEDALUS · v1.0 · MMXXVI · BUILT WITH PURPOSE · ENGINEERED TO ELEVATE`
