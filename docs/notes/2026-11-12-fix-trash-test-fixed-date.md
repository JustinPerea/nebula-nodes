# Pin the clock in the "Delete forever" trash test

`ProjectHome.test.tsx` › "Delete forever confirms on its own row…" used fixture dates from October 2026
(purge on 2026-11-09) without pinning the clock. Once the real date passed the purge date, the meta line
read "Removed for good within" instead of "Removed for good in", and Frontend tests part 3 failed on every
run. The test now fakes `Date` only and sets it to 2026-10-10, like its sibling test. Test-only change.
