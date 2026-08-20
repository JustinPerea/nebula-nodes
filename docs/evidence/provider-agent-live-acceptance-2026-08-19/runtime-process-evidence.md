# Agent cancellation process evidence

## Pre-fix Codex observation

Canvas Stop killed the direct wrapper, while the Codex binary briefly remained
orphaned under PID 1. Because the inspection itself approached the 30-second
sleep duration, this observation established a cleanup race but could not prove
whether the nested sleep exited naturally or from cancellation.

## First post-fix Claude observation

Immediately before Stop, the relevant process topology was:

```text
PID    PPID   PGID   ROLE
89999  89826  89999  Claude CLI started by Nebula
90706  89999  90706  Claude Bash tool shell
90708  90706  90706  python3 time.sleep(30)
```

The shell deliberately created a process group different from the Claude CLI's
group. Nebula killed PGID 89999 and sent WebSocket cancellation confirmation.
The UI therefore displayed `Cancellation requested...` and then `Cancelled.`
([screenshot 49](49-agent-claude-cancel-requested.jpg)).

The immediate post-confirmation process check instead showed:

```text
PID    PPID   PGID   STATE  ROLE
90706  1      90706  Ss     Claude Bash tool shell
90708  90706  90706  S      python3 time.sleep(30)
```

Both processes remained until the original 30-second command ended naturally.
This falsified the first process-group-only repair: an agent tool can create a
new group/session, so cancellation must discover and terminate descendants
before killing and reaping the top-level CLI.

## Replacement cleanup and final live ceiling

The replacement POSIX cleanup freezes the root, repeatedly discovers
descendants by PPID even when they move to another process group or session,
freezes new generations, kills each captured PID, and verifies that every PID
has disappeared before returning success. A deterministic root → child →
`setsid()` grandchild sentinel reproduces the escape shape above; a separate
verification-failure regression proves the backend cannot confirm cleanup when
any captured process remains. Codex's pre-main `login status` subprocess uses
the same isolation and cancellation cleanup.

The final live Daedalus turn reached the UI and the Agent Log correctly labeled
its events `daedalus` ([screenshots 50-51](50-agent-daedalus-cancel-probe-starting.jpg)).
The isolated backend and Vite sessions ended during the interrupted review
before Stop and a post-confirmation process snapshot completed. Because this
was the single approved Daedalus cancellation turn, it was not repeated. The
live full-descendant result is therefore **inconclusive**; the deterministic
separate-session regressions are the exact cleanup proof ceiling.
