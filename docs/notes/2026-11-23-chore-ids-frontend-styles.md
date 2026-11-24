# Internal ids out of the stylesheet comments

## What changed
The last 51 files in `frontend/scripts/internal-ids-baseline.json` were stylesheets (49 in `frontend/src/styles`, plus `agentNotes.css` and `agentRoster.css`). Their comments carried 972 matches: the studio's initials, round ids, question ids and review ids. All are gone, and the baseline is empty for the frontend.

## Rules followed
- Only `/* */` comments change. A script compared every file with comments stripped: 0 differ.
- Where the studio's design side ruled, the comment says "design". Round, question, review and finding ids are dropped, not renamed, so a code-review finding is never credited to design.
- Every reason stays. Public PR numbers stay ("design, PR #208"). A plan label that stood for a merged PR became that PR's number.

## Surprises
- A first pass rewrote about 43 review and finding ids as "design", wrote one plan label as the wrong PR number, and replaced a design round of PR #198 with a review that never happened. A review caught all three before commit, and a fix round corrected them. The check for the first kind: any hunk whose new text gains "design" while its old text had neither the initials nor "design". Four such hunks remain, each traced to a design source (three cite the agent cursor's design spec, one cites PR #204's design round on focus rings).
- `asset-trash.css` met the dead-selector deletion from main in the same hunk; the merge keeps the deletion and the rewritten comment.
