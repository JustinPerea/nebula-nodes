# Agent Skill Bundle

This directory contains repo-backed agent skills and model/provider notes used by Nebula's chat agents.

The backend Codex runner indexes `.agents/skills/*/SKILL.md` at runtime and injects the skill list, trigger guidance, and relevant root skill docs into the Codex prompt. Deeper files under each skill directory are intentionally left on disk for the agent to read when a request needs exact API parameters or model-specific guidance.

Keep this directory safe for the public repository:

- Do not store API keys, credentials, cookies, private prompts, or generated user outputs here.
- Prefer canonical provider docs or checked-in model-provider notes for exact API claims.
- Keep skill files concise enough to be loaded into agent context.
