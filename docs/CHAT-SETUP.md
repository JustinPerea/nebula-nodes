# Chat setup

Nebula runs the installed Claude Code or Codex CLI on your machine. Each official CLI handles its own authentication and usage; Nebula does not collect account credentials. Graph generation models still use their configured providers.

1. Install and sign in to [Claude Code](https://code.claude.com/docs/en/setup) or [Codex](https://learn.chatgpt.com/docs/cli). For Claude, use `claude auth login` in a terminal. For Codex, use `codex login` or the Chat connection controls.
2. Open Chat and its model picker. Choose Claude Code or Codex, an available model, and a supported thinking effort. The choices come from the installed CLI. “CLI default” uses the model default reported by that CLI; when it does not report one, Nebula leaves effort unspecified.
3. Send a message to apply the selection. Opening, refreshing, or changing the picker never starts a turn. Changing model or effort retains the current conversation; changing provider starts a new conversation and keeps earlier messages visible.

The picker remembers model and effort choices for each provider. If a saved choice is unavailable, select a supported choice before sending. Refresh the catalog after changing the CLI login. No email or account token is included in the catalog response.

Codex Chat uses ChatGPT login; an API-key login is identified separately and requires switching to ChatGPT. Claude Code keeps its built-in authentication choices. An API key in its environment can take precedence over subscription login, so check the shown authentication mode. See [Claude authentication](https://code.claude.com/docs/en/authentication) and [Claude Code hosting conditions](https://code.claude.com/docs/en/legal-and-compliance).

This is a local CLI integration. Subscription availability remains governed by each provider’s terms; the model picker is not a hosted subscription gateway. Codex discovery uses the experimental read-only [app-server catalog](https://learn.chatgpt.com/docs/app-server); an unsupported or outdated CLI produces an explicit catalog error. Daedalus remains a separate legacy backend integration, outside Chat’s picker.
