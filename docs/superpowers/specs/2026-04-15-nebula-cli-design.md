# Nebula CLI — Design Spec

## Purpose

A command-line interface that lets users (and Claude Code) discover available nodes, build graphs, and execute media generation pipelines from the terminal. The CLI is the foundation for a future Claude Code skill that automates pipeline construction.

## Architecture

- **Language**: Python, lives in `backend/cli/`
- **Entry point**: `python -m nebula` from project root
- **Backend dependency**: Requires the FastAPI server running on `localhost:8000`
- **Communication**: HTTP calls to the existing backend API via `httpx`
- **Output**: Plain text to stdout (token-efficient for Claude), errors to stderr
- **Graph state**: Managed server-side — the CLI sends commands, the backend tracks state

## Commands

### Discovery

These commands give Claude (or a human) the context to make decisions.

#### `nebula context`

The most important command. Outputs a compact summary (~500 tokens) of:
- Which API keys are configured and what providers they unlock
- Available nodes grouped by category (filtered to only those with valid keys)
- Port type legend (what connects to what)

Designed to be read once at the start of a session.

#### `nebula nodes [--filter <query>] [--category <cat>]`

List all node definitions grouped by category. Optional text filter searches by name. Output format:

```
IMAGE GENERATION (13)
  gpt-image-1-generate    GPT Image 1           openai
  imagen-4-generate       Imagen 4              google
  nano-banana             Nano Banana            google
  ...
VIDEO GENERATION (24)
  ...
```

#### `nebula info <node-id>`

Full detail for a single node:

```
Imagen 4 (imagen-4-generate)
Provider: google | Key: GOOGLE_API_KEY | Exec: sync

INPUTS:
  prompt        Text      required

OUTPUTS:
  image         Image

PARAMS:
  model         enum      imagen-4.0-generate-001  [Imagen 4, Imagen 4 Ultra, Imagen 4 Fast]
  aspectRatio   enum      1:1                      [1:1, 4:3, 3:4, 16:9, 9:16]
  numberOfImages int      1                        min=1 max=4
  seed          int       random
  enhancePrompt bool      false
  imageSize     enum      1K                       [1K, 2K]  (when model != imagen-4.0-fast-generate-001)
  personGeneration enum   allow_adult              [allow_all, allow_adult, dont_allow]
```

#### `nebula keys`

Show configured API keys and what they unlock:

```
CONFIGURED KEYS:
  OPENAI_API_KEY        ***a1b2   12 nodes (GPT Image 1, DALL-E 3, GPT-4o Chat, ...)
  GOOGLE_API_KEY        ***c3d4   7 nodes (Gemini, Imagen 4, Nano Banana, ...)
  FAL_KEY               ***e5f6   35 nodes (FLUX, Kling, Luma, Wan, ...)
  ELEVENLABS_API_KEY    ***g7h8   5 nodes (TTS, SFX, STS, ...)

NOT CONFIGURED:
  RUNWAY_API_KEY                  7 nodes unavailable
  MESHY_API_KEY                   10 nodes unavailable
  ...
```

### Graph Building

#### `nebula create <node-id> [--param key=value ...]`

Create a node instance in the current graph. Returns a short UUID for referencing.

```
$ nebula create imagen-4-generate --param model=imagen-4.0-generate-001
Created node n1 (Imagen 4)
```

Uses short sequential IDs (n1, n2, n3...) for easy reference in subsequent commands.

#### `nebula connect <src>:<port> <dst>:<port>`

Connect an output port to an input port.

```
$ nebula connect n1:image n2:image
Connected n1:image → n2:image (Image)
```

Validates port type compatibility before connecting. Errors if types don't match.

#### `nebula set <node-ref> <key>=<value> [key=value ...]`

Set params on an existing node.

```
$ nebula set n1 aspectRatio=16:9 numberOfImages=2
Updated n1: aspectRatio=16:9, numberOfImages=2
```

#### `nebula graph`

Show current graph state:

```
NODES:
  n1  Imagen 4           model=imagen-4.0-generate-001
  n2  SeedVR2 Upscale    upscale_factor=2

CONNECTIONS:
  n1:image → n2:image (Image)
```

#### `nebula save <file.json>` / `nebula load <file.json>`

Save/load the current graph to/from a JSON file. Same format the frontend uses.

#### `nebula clear`

Clear the current graph.

### Execution

#### `nebula run <node-ref>`

Execute a single node and its dependency chain.

```
$ nebula run n2
Executing n1 (Imagen 4)... done (2.3s) → output/2026-04-15_12-30-00/abc123.png
Executing n2 (SeedVR2 Upscale)... done (4.1s) → output/2026-04-15_12-30-00/def456.png
```

#### `nebula run-all`

Execute the entire graph in topological order.

#### `nebula status`

Show execution state of all nodes in the graph.

### Quick Mode

#### `nebula quick <node-id> [--input key=<file-or-text>] [--param key=value ...]`

One-shot execution without graph building. Creates a node, pipes in inputs, executes, returns output path.

```
$ nebula quick imagen-4-generate --input prompt="a cat in space" --param aspectRatio=16:9
output/2026-04-15_12-30-00/abc123.png
```

For piping between nodes:

```
$ nebula quick imagen-4-generate --input prompt="a cat" | xargs -I{} nebula quick seedvr2-upscale --input image={}
output/2026-04-15_12-30-00/def456.png
```

## Implementation Structure

```
backend/cli/
  __init__.py
  __main__.py          # Entry point, argument parsing
  commands/
    __init__.py
    context.py         # nebula context
    nodes.py           # nebula nodes, nebula info
    keys.py            # nebula keys
    graph.py           # nebula create, connect, set, graph, save, load, clear
    execute.py         # nebula run, run-all, status
    quick.py           # nebula quick
  client.py            # HTTP client wrapper for backend API
  formatter.py         # Text formatting helpers
```

## Backend API Changes Required

The backend needs a few new endpoints for graph management:

```
GET  /api/nodes              # Return all node definitions (for context/info commands)
POST /api/graph/node         # Create a node in the server-side graph
POST /api/graph/connect      # Connect two ports
GET  /api/graph              # Get current graph state
PUT  /api/graph/node/:id     # Update node params
DELETE /api/graph            # Clear graph
POST /api/quick              # One-shot execute: create + run + return output
```

The existing `/api/execute-node` and `/api/execute` endpoints handle execution.

## Output Conventions

- Results go to **stdout** (file paths, node IDs, graph state)
- Errors go to **stderr** (connection refused, validation errors, API failures)
- `nebula quick` outputs only the output file path on success — enables piping
- `nebula context` is compact prose, not tables — optimized for Claude's context window
- No color codes or emoji — clean text that works in any terminal

## Future: Claude Code Skill

After the CLI is built, a Claude Code skill wraps it:
- Reads `nebula context` output at conversation start
- Knows the command syntax
- Can reason about port compatibility and param requirements
- Translates natural language ("make a video of a sunset") into CLI commands
- Handles multi-step pipelines automatically
