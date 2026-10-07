# Create UI repair: independent final review

Reviewed the working diff against published main `362d201b` in the isolated
`krea-release` worktree. This review covers the first Create repair slice;
it does not claim delivery of the remaining Cinema, discovery, Settings or
onboarding audit findings.

**Result: no introduced blocking defect found.** Final native layout acceptance
remains with the parent session, following its discovery of compressed grid rows.

## Final layout correction

The bounded `.results-gallery__items` element now owns scrolling separately from
the naturally sized `.results-gallery__cards` content. Grid rows use
`max-content`; list cards remain in a column. Image/video artwork fits absolutely
inside the square media area, so its intrinsic dimensions and percentage height
cannot establish shrinking grid rows. Existing list-card selectors still match
the outer `items--list` class.

The footer participates in workspace layout and scrolls independently when it
becomes tall. Download format choices expand the card in normal flow, avoiding
menus clipped above the first list item or below the last one. Native normal and
200% zoom checks, with many results and a long prompt, are the final geometry
proof; DOM tests cannot establish those dimensions.

## Draft, credentials and upload ownership

Supported-model defaults read Settings' provider keys only to choose the parameter
schema; they do not copy credential values into draft parameters. The current
catalog has no provider-key/password credential parameter. `_kreaAuth` is the
saved billing-route choice (`api-token` or `mcp`), rather than a token value.
The persistent draft contains authoring state and ready reference paths; it does
not serialize Settings, File objects or AbortControllers. Generic authoring
parameters and user-entered text are not a general secret-redaction boundary for
arbitrary imported payloads.

Persisted pending uploads hydrate as interrupted errors, requiring explicit
Attach again or Remove. Page-lifetime File/controller maps remain transient;
accepted uploads can complete while Create is unmounted. Completion checks the
current upload ID, attempt and uploading state before appending to the current
reference collection. Remove/reset erase ownership before aborting transport;
late responses therefore cannot repopulate the draft.

Generate reads the current shared draft, checking pending/error references before
reserving or authoring a generation. This protects stale callbacks and immediate
Attach-to-Generate races independently of disabled controls. Editing, navigation,
upload completion, hydration and reset contain no generation side effect.

## Focus and output continuity

Actions and fullscreen controls remain available without hover. Fullscreen uses
the existing focus hook for initial focus, Tab containment and opener restoration.
Boundary navigation preserves focus when its button disappears; missing openers
fall back to the stable results region or source toolbar. Removing the last
viewable output closes the viewer before later media arrives, preventing automatic
reopening. Native video arrow controls remain available.

Download choices receive focus, support arrow/Home/End navigation, dismiss on
Escape/outside interaction and restore the trigger. Output-keyed save ownership
and stale export/timer fences remain unchanged.

## Independent automated evidence

Added and ran seven integration regressions in
`frontend/tests/components/CreateView.draft.test.tsx`. They cover all draft fields
across Canvas reselection, History, stale Generate admission, failed-upload retry,
completion while unmounted, reset/late responses, one-time Style handoff, and
preservation of graph nodes, connections and earlier run metadata. All seven
passed, together with TypeScript, scoped ESLint and diff checks.

The final review after the layout correction was read-only for application source.
No provider calls, real-state access, dependency installation, commit or publication
was performed by this reviewer.
