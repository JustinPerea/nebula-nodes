# fix/pin-text-corpus-flake

## Cause

`frontend/src/lib/canvasPins.ts` loads its Unicode data (`pinTextUnicode.json`)
as a lazy chunk when the module is first evaluated (review 13 L-2). Until the
import settles, the text rules use the strict fallbacks: no variation selector
fits, no tag run is a flag, no ZWJ chain is RGI. `agentPresenceFollowups.r12text`
called `pinDisplayText` on the shared corpus without waiting for the chunk, so it
raced its own import.

- Alone, the Vite transform of the 100 KB JSON is cold and loses the race every
  time. A probe in that file read `pinTextIsLoaded() === false` and 206 note
  mismatches at test start, then `true` and 0 mismatches about 20 ms after
  `await pinTextReady`.
- In CI the result came down to runner timing. Run 41569694838 (c950e92c),
  attempt 1: "Frontend tests (part 1 of 3)" failed this test. Attempt 2 on the
  same commit, with the same shard and the same files, passed. The 02b291ba run
  passed with an identical test-file set and identical pin files. Locally the
  whole shard passed once before the fix.
- Ruled out: Unicode differences in the Node runtime (once loaded, Node 22.16
  gives 0 mismatches, the same as CI's 22.23 when it passed), locale and time
  (nothing in the rules reads them), and state shared between files (vitest
  isolates each file, so every file gets a fresh canvasPins and its own
  import).
- `agentPresenceFollowups.r13text` had the same race. Run alone, 19 of its 33
  tests failed.

## Product

The pins never showed the wrong text to a person. The store awaits
`pinTextSettling()` before it sanitizes a pin (hydrate, push, send).
PinComposer waits before it counts. `onPinTextLoaded` refits and redraws pins
that are already on screen. The fallback form only shows while a failed chunk
waits for its retry, and that is by design: it errs toward hiding. Nothing in
the product changed.

## Change

- `r12text` and `r13text` now wait in `beforeAll` for `await pinTextReady`,
  then assert `pinTextIsLoaded()`. If the chunk fails to load, the error now
  names the load instead of looking like 400 Unicode mismatches.
- `r4`, `r10`, `r11`, `r12` and `r13` import the same rules and passed only
  because their inputs don't need the data. They now wait too
  (`beforeAll(() => pinTextReady)`, the pattern r14 and r23 already use).
- New `tests/pinTextReadyRatchet.test.ts` fails any test file that imports
  `pinDisplayText`, `textLength`, `noteLength`, `fitNote`, `keptNoteDisplay` or
  `noteIsEmpty` from `lib/canvasPins` without naming `pinTextReady` or
  `pinTextSettling`. Checked: with the old r12text in place, it fails and names
  that file.
