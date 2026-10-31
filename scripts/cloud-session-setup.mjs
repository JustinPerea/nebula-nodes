// The SessionStart hook in .claude/settings.json. It starts
// cloud-session-setup.sh only in a Claude Code cloud session on Linux, and is
// a no-op everywhere else, including Windows: a hook that ran `bash` directly
// would fail there without bash on PATH, or boot WSL at every session start.
// Node is the one runtime every checkout of this repo already has.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.env.CLAUDE_CODE_REMOTE === 'true' && process.platform === 'linux') {
  // The hook's JSON on stdin and Claude's context on stdout pass straight
  // through. The script always exits 0 and reports failures itself.
  spawnSync('bash', [fileURLToPath(new URL('./cloud-session-setup.sh', import.meta.url))], {
    stdio: 'inherit',
  })
}
process.exit(0)
