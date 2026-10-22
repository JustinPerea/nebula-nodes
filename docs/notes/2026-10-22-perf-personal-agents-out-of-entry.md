# 2026-10-22 — Settings' Personal agents section leaves the first load

Branch `perf/personal-agents-out-of-entry`, from main at 8246211f (#160).

- **Why:** main's startup entry was 511,697 of the 512,000-byte budget, and #156 (SeedVR2 pricing, Q110 a) came out 115 bytes over once it took main in. The limit stays (raising it is Justin's call).
- **What changed:** ChatPanel imported one string, `PERSONAL_AGENTS_CHANGED_EVENT`, from `settings/PersonalAgentsSection.tsx`. That pulled the whole section into the entry, though the section only renders inside Settings' Preferences tab, which loads with its own dynamic import. The name now lives in `lib/personalAgentsEvents.ts`, and both files import it from there.
- **Size:** entry 511,697 → 503,720 bytes raw (149,710 → 147,797 gzip). The section's JavaScript now ships in the PreferencesTab chunk, which Settings already loads lazily and preloads, so opening Preferences shows no new loading step.
- **CSS unchanged:** `styles/personal-agents.css` stays in the first load, because ChatPanel, PermissionCard and PersonalAgentWarning import it themselves (the chat's personal-agent dot, options and warning use it).
- **Guard:** `components/panels/settings/PersonalAgentsSection.tsx` joins `DEFERRED_MODULES`, so `tests/entrySplit.test.ts` fails, naming the import chain, if anything on the startup path imports it again. The test failed first on main: `main.tsx -> App.tsx -> components/panels/ChatPanel.tsx -> components/panels/settings/PersonalAgentsSection.tsx`.
- **Agents:** nothing agents call changes (frontend bundling only).
- **Open:** the entry grew from 472,693 (#103, 2026-10-20) to 511,697 in two days, so this headroom will go too. Followed by a second split pass (`perf/entry-split-2`, notes in 2026-10-22-perf-entry-split-2.md) that makes deferral the default, rather than a question to Justin; the limit is unchanged.
