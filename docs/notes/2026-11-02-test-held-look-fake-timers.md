# test/held-look-fake-timers (2026-11-02)

## What was wrong

`frontend/tests/pr198Fix25Held.test.tsx`, "review 23 NIT-5: the 150 ms rule,
by the order of events", failed twice on CI: "no answer for 150 ms" measured
`grey.at - held.at = 148.3` against `HELD_LOOK_DELAY_MS - 1 = 149`.

Both stamps came from a MutationObserver callback on `performance.now()`.
The click handler arms the hook's 150 ms `setTimeout` first, and the observer
stamps the hold afterwards, in a microtask. Node can also fire a timer about
1 ms early against `performance.now()`. So the measured gap could fall under
150 ms even though the hook kept the rule. The product code was right; the
measurement wasn't.

## Decisions

- **Fake timers from the click on.** Setup (the scene stopping on 500s, the
  line appearing) still runs on real timers, as before. Right before the click,
  the first two tests call `vi.useFakeTimers({ toFake: ['setTimeout',
  'clearTimeout', 'performance', 'Date'] })`, so the hook's timer, the
  observer's stamps and the fake backend's `answered` stamp share one clock
  that moves only when the test moves it. Promises and the observer's
  callbacks stay real; `step(ms)` advances the clock inside `act` and lets them
  settle. A `describe`-level `afterEach` puts real timers back.
- **The assertions are stricter, not looser.** The old `>= 149` (a 1 ms
  allowance for jitter) is now `>= 150`, and each test checks the boundary
  directly:
  - "no answer for 150 ms": at 149 ms, still held and pending with no grey;
    at 150 ms, grey. The other checks are kept: the hold comes at once with no
    grey, it is held and pending until the grey, and the grey goes with the
    answer.
  - "an answer inside 150 ms": the answer used to come back at once. It is now
    held and let go at 149 ms, the last moment inside the rule. The test checks
    there is no grey at 149 ms, that the answer was stamped inside 150 ms, and
    that no grey shows by 450 ms. The old "any grey only after 150 ms with no
    answer" loop is kept. The old `if (answeredIn < 140)` guard is gone,
    because the answer time is now fixed.
- **Checked against the product rule.** With the hook's timer temporarily at
  149 ms, both tests fail; at 151 ms, the first fails. With the hook unchanged,
  the file passed 30 runs in a row.
- **The third test in the describe** ("a slow try that fails again") stays on
  real timers. It only orders events on one clock (`event.at > answered`) and
  never compares a gap against the delay.

## Same pattern elsewhere

A search of `frontend/tests` for real `performance.now()` / `Date.now()` gaps
compared against a timer delay found only these two tests. Every other use
sets fixed timestamps (`runStartedAt`, `createdAt`, `expiresAt`) or feeds a
fake `requestAnimationFrame`.
