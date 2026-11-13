# Agent retrieval: smaller skill and context payloads (explore later)

Status: **explore later**. Kept as ideas, not scheduled.

Captured 2026-11-06 after reading "Context Engineering Starts with Retrieval" (Jess Weng, LangChain, 2026-10-23):
https://www.langchain.com/blog/context-engineering-starts-with-retrieval

The article's points that matter here: search names and keywords before loading anything, page through big results, return pointers instead of payloads, and load a skill's full text only when a task needs it (progressive disclosure).

What Nebula already does along these lines: `nebula nodes <words>` searches node types by keyword, best matches first; `nebula info` gives one node's params and ports; `nebula context` shows only the first nodes of a big canvas and points to `nebula look`; run outputs come back as `/api/outputs/...` paths, not file contents.

---

## 1. Split the nebula skill and the large provider skills into references

`skills/nebula/SKILL.md` is about 36 KB in one file, so an agent loads all of it the moment the skill triggers.

- Keep the core in SKILL.md: start here, find nodes, `nebula apply`, run, propose, rules.
- Move Moodboards (about 260 lines), Styles, Port types, Utility nodes and "Watch and answer the person" into `skills/nebula/references/*.md`, each linked from SKILL.md with one line saying when to read it.
- The per-provider skills in `.agents/skills` already load only their frontmatter until needed, but several are 20–32 KB with no `references/` folder (krea, openai, elevenlabs, replicate, anthropic). Split them the same way.

Why: less context spent per task, and the niche detail is still there when the task needs it.

## 2. Make `nebula context` an index, after measuring it

`nebula context` is the first call an agent makes. It puts the open project's canvas, pins, proposals, every moodboard (this project's, Global and other projects'), the full catalog of node types that run here with prices, and the spending limits into one answer.

- **First, measure** its size (text and `--json`) on a busy install: many projects, many moodboards, every provider keyed.
- If it is large, keep full detail only for the open project. For other projects' boards and for the node catalog, give counts, ids and names, plus the exact follow-up commands (`nebula nodes <words>`, `nebula moodboard show <id>`, `nebula info <node>`).
- The MCP tools that return the same data need the same change (every feature keeps MCP parity).

Why: the first call stays small however much the person has built, and the agent fetches detail only for what it is about to use.
