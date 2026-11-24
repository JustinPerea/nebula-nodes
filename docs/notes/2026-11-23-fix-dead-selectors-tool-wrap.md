# Chat tool output wraps at spaces; three dead selectors removed

## Decisions
- The wrap rule is shared by `.chat__tool-input` and `.chat__tool-output`, so both change. The input box shows a tool's arguments (often a path or a command) in the same chat block, and splitting words there has the same problem.
- `overflow-wrap: break-word`, not `anywhere`: with `break-word` a long token still breaks inside the box but does not lower the box's min-content width. The box has a fixed width in the chat panel, so the two render the same here; `break-word` is the narrower change.
- Other wrap rules outside the chat were left alone. No `word-break: break-all` remains in `frontend/src`. `overflow-wrap: anywhere` is used elsewhere (node library names, metadata and others) and was not changed.

## Measured
In the running app with real tool blocks (tool_use and tool_result events on the chat socket), chat panel at its default width (tool box 304px):
- Before, the error sentence split inside four ordinary words ("No such f|ile", "moved b|efore"). After, it wraps at spaces. Its long path still breaks once inside, because the path alone is wider than the box.
- Paths break after `/` and `-` where they can. No box overflows, before or after.
- Three of the four boxes are one line taller after (17.8px), since wrapping at spaces leaves shorter lines. The boxes keep `max-height: 200px` with their own scroll.

## Dead selectors
`.moodboard-node__open-error`, `.character-node__open-error` and `.chat-panel__thinking-caret` match nothing: no component, test or script uses the class names. Their rules are deleted; in slava-restraint.css only the caret selector leaves a shared rule, which keeps `.chat-panel__thinking-line`.
