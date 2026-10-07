# Create gallery implementation notes — 2026-10-07

- Kept the current Slava Restraint appearance. The repair changes layout and input access; it introduces no appearance switch, model behavior or history mutation.
- Replaced the absolutely positioned composer and fixed bottom padding with a layout footer. `create-view__composer-area` groups references and composer, reserves their actual height, and scrolls when larger than 48% of the viewport. The gallery toolbar stays outside its independent results scroll area.
- List cards use a 96px thumbnail, a model/node label, available prompt excerpt and persistent action row. Grid cards also show the same label/excerpt. This is a small orientation aid, not recipe editing or the later comparison workflow.
- Persistent action bars and fullscreen buttons preserve artwork visibility and expose native, named controls for keyboard/touch. The full-image pointer overlay remains, but leaves the tab order because the adjacent fullscreen button owns keyboard access.
- Download format choices are in-flow. An upward popup would clip at the first list row inside the bounded scroller; growing only the current card keeps first/last choices reachable. Focus enters the formats, arrow/Home/End keys move through choices, Escape restores Download, and outside/blur input dismisses them.
- Fullscreen reuses `usePanelFocus` for initial focus, Tab containment, Escape and opener return. Gallery navigation only handles arrows from the dialog and leaves native video-player arrows alone. Removing a focused boundary arrow refocuses Close; replacement of the opener falls back to the results region. Removing the final viewable output closes/reset the viewer and returns to the source toolbar so a later result does not reopen it automatically.
- Kept `ResultCardOutput` keyed by node/output URL. Pending exports cannot update a replacement output's save state or timer.
- Scoped upload-chip styles support the root agent's pending/error/retry/remove UI without moving references outside the bounded composer footer.
- Native verification caught implicit grid rows shrinking within the bounded scroll area's definite height. Split the scroll viewport from the naturally sized card grid/list; explicitly use `max-content` grid rows and absolutely fit raster/video artwork inside its square preview. This preserves full card height while excess rows overflow the independent viewport.

## Verification

- `npm test -- tests/components/ResultCard.test.tsx tests/components/Lightbox.test.tsx tests/components/ResultsGallery.test.tsx`: **34 passed**.
- Targeted ESLint on those three components and three test files: passed.
- Native browser layout verification is owned by the root agent. Unit tests cover 30-result order/filter/action preservation and focus lifecycle; they do not claim viewport geometry or real generation.

No real provider, account, generation, private workspace, dependency installation or parent checkout was used.
