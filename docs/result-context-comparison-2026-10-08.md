# Result context and comparison

Implemented UI audit item 10 on isolated `codex/result-context-comparison`, above the local model-discovery and onboarding slices. The parent checkout, real app, credentials, providers and packaged Electron remain outside this change.

## Experience

- Gallery results show their model and recorded run time. Saved recipe expands to the full prompt, parameters, connected inputs and image reference count.
- Select two image/video results, then Compare selected. The pair keeps its media and recipe snapshots across node edits, replacement, filters and deletion during the Create visit. Closing restores focus; narrow layouts stack the pair with reachable scrolling. Videos retain controls without autoplay.
- Reuse settings copies one result into a fresh Create draft with one variation. Generate remains explicit. Undo restores the previous ready draft until further authoring changes it. Unfinished attachments are cancelled and require attachment again after Undo.
- Krea's saved access mode survives copying. Other dual-provider nodes use current configured credentials, which the disclosure states.

## Attribution and continuity

Live Canvas parameters and Create-origin captions are mutable and cannot prove what generated an output. Context instead matches actual outputs against a terminal saved run and reads its frozen snapshot. Unknown/imported/older outputs without matching history show current settings explicitly and cannot claim original recipe reuse.

Ordinary runs previously omitted their completed output references. Every owned running record now retains immutable outputs for executed nodes, including upstream prompts/references and cache-hit completion events. Terminal/unknown/unowned events cannot rewrite that history. Paper and Cinema freshness, replay and batch history retain their existing behavior.

Every connected input remains inspectable, including start/end frames, structured values and explicit missing values. Create-incompatible inputs, unresolved references and multi-item iterator recipes disable draft reuse with a recovery explanation. Their full saved Canvas recipes remain in Run History.

## Verification

- 1,575 frontend tests in 156 files passed, including actual store execution-event capture, persisted reload, partial failure/cancellation, stale event/upload rejection, pinned comparison and explicit Generate admission.
- ESLint, style guards, TypeScript, production build/budget and all 255 node contracts passed. Entry: 325,394 bytes raw / 91,280 bytes gzip; 37 JavaScript assets passed the runtime-code-generation scan.
- Independent review identified and verified the output-capture repair, persistent gallery mounting and complete connected-input metadata.
- Private synthetic browser fixture on 5226/8056 verified saved recipe inspection, two-result selection, modal focus wrapping, workspace shortcut containment, reuse, composer focus and Undo. Desktop geometry was inspected at 1200×758; compact interaction/layout at 600×379.
- Exact graph export stayed unchanged: seven nodes and six connections. Zero generation, credential-check or motion-handoff requests. No paid provider execution was attempted.

The normal-width gallery was captured in native Dia at 2192×1776 physical pixels. Native Chrome control timed out, and native Dia input was inconsistent; final modal/reuse interaction proof used the in-app browser. Actual native browser 200% zoom remains unverified. The desktop viewport override exceeded the visible browser panel, clipping its captured pixels; that comparison capture is not full desktop visual proof. Synthetic screenshots, fixtures and proof files stay outside Git. Temporary preview tabs and servers were closed; the original native browser tabs remain intact.

This slice is local and unmerged. Shared navigation/control hierarchy is the next audit item.
