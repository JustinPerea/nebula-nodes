# Provider and agent live-acceptance screenshots

The committed copies are cropped to the Nebula application viewport and have
image metadata removed. This keeps unrelated browser tabs and bookmarks out of
the public repository without altering the runtime evidence.

Captured in Chrome against the disposable Nebula state/output roots on
2026-08-19. The user's normal 8-node / 5-edge graph was not used for these
runs.

## Provider results

| Evidence | What it shows |
|---|---|
| [04](04-nous-auth-failure-retry-ready.jpg), [05](05-nous-retry-running.jpg), [06](06-nous-retry-complete.jpg) | Nous's stale preferred credential failed before fallback hardening |
| [07](07-nous-free-running.jpg), [08](08-nous-free-complete.jpg), [09](09-nous-free-persisted-after-reload.jpg) | Nous free-model success and reload persistence |
| [10](10-anthropic-running.jpg), [11](11-anthropic-failed.jpg), [12](12-anthropic-failure-details.jpg) | Anthropic account-credit rejection |
| [13](13-elevenlabs-after-run.jpg), [14](14-elevenlabs-complete.jpg), [15](15-elevenlabs-persisted-after-reload.jpg) | ElevenLabs output and the original reload-only playback behavior |
| [16](16-fal-flux-running.jpg) | FAL request before the provider returned its locked-account response |
| [17](17-replicate-schema-fetched.jpg), [18](18-replicate-schema-loaded.jpg), [19](19-replicate-running.jpg), [20](20-replicate-cancelled.jpg) | Replicate schema and initial execution/cancel exploration |
| [21](21-replicate-fixed-running.jpg), [22](22-replicate-fixed-complete.jpg), [23](23-replicate-fixed-final.jpg), [24](24-replicate-cancelled-after-task-id.jpg), [25](25-replicate-cancel-terminal.jpg), [26](26-replicate-reset-after-dev-reload.jpg), [27](27-replicate-stable-running.jpg), [28](28-replicate-stable-complete.jpg) | Replicate defect isolation and intermediate retests |
| [29](29-replicate-streamed-image-fixed.jpg) | Final streamed data-URI result rendered as a persisted image |
| [30](30-elevenlabs-regression-ready.jpg), [31](31-elevenlabs-immediate-playback-fixed.jpg) | ElevenLabs media URL fix and immediate playback without reload |
| [32](32-runway-tts-result.jpg), [33](33-runway-credit-blocked-details.jpg) | Runway credit-gated failure |
| [34](34-meshy-credit-blocked-details.jpg) | Meshy free-plan task-creation rejection |
| [35](35-ideogram-transparent-result.jpg), [36](36-ideogram-transparent-success.jpg) | Ideogram transparent PNG success |
| [37](37-quiver-credit-blocked.jpg) | Quiver insufficient-credit rejection |

OpenRouter and Gemini completed before this numbered evidence directory was
created; their live final text and persisted graph state are recorded in the
acceptance report, but no screenshot is claimed for those two runs.

## Agent results

| Evidence | What it shows |
|---|---|
| [38](38-agent-claude-readonly-success.jpg), [39](39-agent-claude-mutation-success.jpg) | Claude read-only inventory and isolated graph mutation |
| [40](40-agent-log-claude-misattributed-hermes.jpg) | Pre-fix Claude activity incorrectly labeled `hermes` |
| [41](41-agent-codex-readonly-success.jpg), [42](42-agent-codex-mutation-misattributed-hermes.jpg) | Codex inventory/mutation plus the same attribution defect |
| [43](43-agent-daedalus-readonly-incomplete.jpg), [44](44-agent-daedalus-mutation-success.jpg) | Daedalus partial read-only response and successful isolated mutation |
| [45](45-agent-codex-cancel-command-running.jpg), [46](46-agent-codex-stop-immediate-state.jpg) | Pre-fix Stop claimed immediate cancellation while descendant cleanup was unacknowledged |
| [47](47-agent-fix-restart-ready.jpg), [48](48-agent-claude-cancel-probe-running.jpg), [49](49-agent-claude-cancel-requested.jpg) | First post-fix UI retest: requested/confirmed copy was truthful in sequence, but a re-grouped shell survived; see [process evidence](runtime-process-evidence.md) |
| [50](50-agent-daedalus-cancel-probe-starting.jpg), [51](51-agent-daedalus-attribution-and-cancel-running.jpg) | Final Daedalus turn starting and corrected `daedalus` Agent Log attribution; the isolated sessions ended before Stop/process inspection, so this is not full-descendant cancellation proof |

The descendant-tree repair is covered by a deterministic root → child →
separate-session grandchild sentinel plus cleanup-verification failure tests.
The final live cancellation result is explicitly inconclusive because the one
approved Daedalus cancellation turn was interrupted and was not repeated.

## Restoration

| Evidence | What it shows |
|---|---|
| [52](52-original-graph-restored.jpg), [53](53-original-graph-restored-fit.jpg) | Normal `127.0.0.1:5173` runtime after restoration. The backend loaded the original 8 nodes / 5 edges, the UI reports 8 nodes, and the raw state SHA-256 remains `b23e8b5ffd4f1dd60c26412fe9bf69a0156faa517c284afebfc3447112a456ad`. |
