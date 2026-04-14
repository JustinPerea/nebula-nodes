# Nebula Node

**Open-source, locally-run AI node editor. Bring your own API keys.**

Nebula Node is a visual programming environment for chaining AI models together. Drop nodes onto a canvas, connect their ports, and run the graph — images feed into video generators, text flows into image models, audio emerges from language models. All computation happens through your own API accounts; the app never sees your data and never charges you a platform fee.

---

## Features

- Visual node-and-edge graph editor powered by React Flow
- 14 built-in model nodes across text, image, video, and audio
- 3 universal nodes (OpenRouter, Replicate, FAL) for any model on those platforms
- Streaming text output with live token-by-token display
- Execution caching — unchanged subgraphs skip re-computation
- Execute the full graph or a single node's upstream subgraph
- Undo/redo with a 50-step history (outputs survive undo)
- Copy, paste, and duplicate nodes with UUID regeneration
- API key warnings shown at node drop time
- Typed ports with color-coded compatibility enforcement
- Save/load graphs as JSON
- Outputs written to disk and served via `/api/outputs`

---

## Quick Start

**Requirements:** Python 3.12+, Node.js 18+

```bash
# 1. Clone
git clone https://github.com/your-org/nebula_nodes.git
cd nebula_nodes

# 2. Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev

# 4. Open http://localhost:5173
```

---

## Adding API Keys

**Via the Settings panel** (recommended): Click the gear icon in the toolbar, paste your keys into the relevant fields, and hit Save. Keys are masked on read; the backend only stores the raw value, never logs it.

**Via settings.json** (manual): Edit the file at the project root directly:

```json
{
  "apiKeys": {
    "OPENAI_API_KEY": "your-key-here",
    "ANTHROPIC_API_KEY": "your-key-here",
    "RUNWAY_API_KEY": "your-key-here",
    "OPENROUTER_API_KEY": "your-key-here",
    "REPLICATE_API_TOKEN": "your-key-here",
    "FAL_KEY": "your-key-here",
    "GOOGLE_API_KEY": "your-key-here"
  }
}
```

---

## Supported Models

### Built-in Nodes

| Node | Provider | Output Type |
|------|----------|-------------|
| GPT Image 1 | OpenAI | Image |
| DALL-E 3 | OpenAI | Image |
| GPT-4o Chat | OpenAI | Text |
| Sora 2 | OpenAI | Video |
| Claude | Anthropic | Text |
| Gemini | Google | Text |
| Imagen 4 | Google | Image |
| Runway Gen-4 Turbo | Runway | Video |
| Kling v2.1 | FAL | Video |
| FLUX 1.1 Ultra | FAL | Image |
| ElevenLabs TTS | ElevenLabs | Audio |
| Text Input | Utility | Text |
| Image Input | Utility | Image |
| Preview | Utility | — |

### Universal Nodes

| Node | Platform | What it gives you |
|------|----------|--------------------|
| OpenRouter | OpenRouter | Any model in the OpenRouter catalog, schema fetched at configuration time |
| Replicate | Replicate | Any versioned model on Replicate; ports built from the model's JSON schema |
| FAL | FAL | Any FAL endpoint via the submit/poll async pattern |

---

## Architecture

The frontend is a React 19 + Vite SPA using `@xyflow/react` for the canvas and Zustand for all graph and UI state. The backend is a FastAPI server that exposes REST endpoints for execution and a WebSocket endpoint (`/ws`) that streams execution events back to the UI in real time. Node state lives in `node.data` inside the React Flow store — this is the "single source of truth" for params, outputs, and execution status. Each model maps to a handler function in `backend/handlers/`; the execution engine topologically sorts the graph and runs handlers in dependency order, passing outputs forward through the edge graph. Proxy routes for OpenRouter, Replicate, and FAL allow the frontend to browse available models without exposing API keys to the browser.

---

## License

MIT
