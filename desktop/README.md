# Nebula Desktop, phase 1

This is the Electron renderer shell. The FastAPI backend remains a manually
started local process during this phase.

## Development

In terminal one:

```bash
cd backend
uvicorn main:app --port 8000
```

In terminal two:

```bash
cd frontend
npm run dev
```

In terminal three:

```bash
cd desktop
npm install
npm run start:dev
```

## Release-like shell check

Build the renderer with relative `file://` asset paths, start the backend as
above, then launch Electron:

```bash
cd frontend && npm run build:desktop
cd ../desktop && npm run start
```

Phase 1 intentionally does not package or launch Python. The next phase adds
the managed FastAPI sidecar.
