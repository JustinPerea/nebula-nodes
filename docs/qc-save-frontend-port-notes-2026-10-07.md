# Create save port notes — 2026-10-07

- Port only the parent checkout's Create save behavior into `codex/qc-save-fixes`, based on audit release `641450c`. Preserve its Create admission, import reservation, run ownership, history and Krea mode guards.
- Reuse the existing mounted ref in CreateView. Its result-save delegate returns the existing web export Promise, letting ResultCard report pending, cancellation, rejection and acknowledged success. No API, store, desktop bridge or Commons changes are required.
- Use a generic body-portalled text dialog for style naming. A ref guards duplicate requests before the naming Promise resolves; failed names remain available for explicit retry. Replacement and unmount resolve abandoned prompts neutrally.
- Keep the existing download/transcode handlers. Add only save-error rules to the current Create styles; the prompt uses the existing Slava tokens and owns its own focus trap/Escape handling.
- Review identified that a pending export can outlive a change to the same node's media output. Key the private card state by node ID and media URL, then check a captured request version for asynchronous state updates and timers. A replacement gets fresh save state; the old export continues, but cannot mark the new output Saved, report its error, or clear its pending request. No server/API change is required.
- Carry focused save/dialog regressions and add integration coverage for the actual CreateView export delegate and preset refetch timing. Verification is limited to targeted frontend tests, TypeScript and touched-file ESLint; no browser, provider or native desktop acceptance is claimed.

Validation:
- 39 tests passed across ResultCard, CreateView.save, PromptDialog, CreateView.lifecycle, createFiles and createPresets. The new delegate case exercises the real CreateView/ResultsGallery/ResultCard chain with mocked export storage; the refetch case exercises the real PresetLibrary after delayed mocked persistence. Replacement-output cases cover old success/error completions, a newer pending export, node changes at the same URL and success timer isolation.
- App TypeScript passed with `--noEmit --incremental false`; ESLint passed for all touched TypeScript source and tests. Existing admission and import guards remain intact, and download/transcode handling is unchanged.
- Independent source review found no remaining concrete defect after the output-ownership repair; it confirmed node/URL replacement, stale completion and timer isolation.
- Coordinating-agent final gates passed all 1,015 frontend tests in 107 files, full lint, and production build/budget (297,021 bytes raw / 83,042 bytes gzip; 34 eval-free JavaScript assets). No browser, provider or native desktop acceptance is claimed.
