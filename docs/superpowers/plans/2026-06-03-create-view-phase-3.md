# Create View — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a presets/styles library to the Create view — a file-backed store of named "styles" (prompt fragment + params + optional model), a seeded starter set, a searchable/filterable library popover that pre-fills the composer when applied, and "save current as style".

**Architecture:** Mirror the existing Moodboard/Character "store" pattern exactly: `preset_store.py` (file-backed, scope-aware) + `/api/presets` CRUD routes + a frontend client + a `PresetLibrary` popover opened from a new "Styles" button in the composer. Applying a preset is a pure merge into the composer's `{modelId, prompt, params}`. A first-run seeder ships ~12 curated presets (NEW pattern — no seeding exists today). Preset cards are **typographic** (ALL-CAPS name + category over a Slava gradient) so no binary thumbnails need shipping and the OUTPUT_ROOT-only static constraint is moot.

**Tech Stack:** FastAPI + pytest, React 19 + Zustand + Vitest, Slava Restraint CSS.

**Spec:** `docs/superpowers/specs/2026-06-02-higgsfield-create-view-design.md` §6.5.

**Builds on:** P1/P2 Create view (`components/create-studio/*`, `CreateComposer`, `CreateView`, `lib/createParams.ts`/`buildDefaultParamsForUi`).

---

## Key contracts (verified)

- **Store template:** `backend/services/moodboard_store.py` — `~/.nebula/moodboards/_global/<id>.json` (global) and `~/.nebula/moodboards/<projectId>/<id>.json` (project); env override `NEBULA_MOODBOARD_ROOT`; `uuid4().hex[:12]` ids; atomic `_write_json` (tmp + replace); cross-scope `_find_*_file`; immutable `{id, createdAt, projectId}`; `update` bumps `version` + `updatedAt`; id regex `^[A-Za-z0-9_-]{1,64}$`. CRUD: `create(...)`, `get(id)`, `list(scope, projectId=None)`, `update(id, **fields)`, `delete(id)`.
- **Routes template:** `/api/moodboards` in `backend/main.py:2095-2179` — `GET ?scope=&projectId=`, `POST`, `GET/{id}`, `PUT/{id}`, `DELETE/{id}`; Pydantic `MoodboardCreate`/`MoodboardUpdate`; `_validate_project_id_param`.
- **Frontend client template:** `frontend/src/lib/api.ts:237-274` — `fetchMoodboards`/`createMoodboard`/`updateMoodboard`/`deleteMoodboard` via `apiFetch`.
- **Library component template:** `frontend/src/components/panels/MoodboardLibrary.tsx` (scope tabs, list, drag MIME, click/double-click). The Create `PresetLibrary` is an in-view popover (not a canvas panel), but reuse the fetch/scope structure.
- **Save-from-editor template:** `MoodboardStudioView.tsx` create-then-`setSavedId` flow.
- **No seeding pattern exists** anywhere — P3 introduces one. **Only `OUTPUT_ROOT` is served** (`/api/outputs` StaticFiles mount); there is no arbitrary-file route — hence typographic cards, no shipped image thumbnails.
- **Composer state (P1/P2):** `CreateView` owns `modelId`, `prompt`, `params` (seeded via `buildDefaultParamsForUi`), `refs`, `quantity`. `CreateComposer` props include `modelDef`, `prompt`, `params`, `onSelectModel`, `onParamsChange`, `onPromptChange`, `onGenerate`, `onAttach`, `quantity`, `onQuantityChange`.

---

## File Structure

**Backend — create:**
- `backend/services/preset_store.py` — file-backed preset store (mirror moodboard_store).
- `backend/data/presets/seed.json` — shipped starter presets (JSON array, no binaries).
- `backend/tests/test_preset_store.py`, `backend/tests/test_preset_api.py`, `backend/tests/test_preset_seed.py`.

**Backend — modify:**
- `backend/main.py` — `/api/presets` routes + Pydantic models; call the seeder at startup.

**Frontend — create:**
- `frontend/src/lib/createPresets.ts` — `Preset` type + `fetchPresets`/`createPreset`/`deletePreset`.
- `frontend/src/lib/applyPreset.ts` — `applyPresetToComposer(preset, current)` pure merge.
- `frontend/src/components/create-studio/PresetCard.tsx`
- `frontend/src/components/create-studio/PresetLibrary.tsx`
- `frontend/tests/lib/createPresets.test.ts`, `frontend/tests/lib/applyPreset.test.ts`.

**Frontend — modify:**
- `frontend/src/components/create-studio/CreateComposer.tsx` — add a "Styles" button.
- `frontend/src/components/create-studio/CreateView.tsx` — preset library open state, apply-preset, save-current-as-style.
- `frontend/src/styles/create-gallery.css` — preset library + card styles (Slava-scoped).

> No `NODE_DEFINITIONS` changes. Gates: backend `pytest`, `tsc`, `vitest`, `npm run build`, eslint + css-scope on new files.

---

## Phase A — Backend store, routes, seeding

### Task A1: `preset_store.py`

**Files:**
- Create: `backend/services/preset_store.py`
- Test: `backend/tests/test_preset_store.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_preset_store.py`:

```python
import os
from pathlib import Path
import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import importlib
    from backend.services import preset_store as ps
    importlib.reload(ps)
    return ps.PresetStore()


def test_create_and_get_roundtrip(store):
    p = store.create(name="Cinematic Noir", category="Cinematic",
                     prompt="high-contrast film noir lighting", params={"aspect_ratio": "16:9"},
                     modelId="nano-banana", refImages=[], scope="global", projectId=None)
    assert len(p["id"]) == 12
    assert p["name"] == "Cinematic Noir"
    assert p["version"] == 1
    got = store.get(p["id"])
    assert got["prompt"] == "high-contrast film noir lighting"
    assert got["params"] == {"aspect_ratio": "16:9"}


def test_list_is_scope_isolated(store):
    store.create(name="G", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    store.create(name="P", category="X", prompt="", params={}, modelId=None, refImages=[], scope="project", projectId="proj1")
    glob = store.list("global")
    proj = store.list("project", "proj1")
    assert [p["name"] for p in glob] == ["G"]
    assert [p["name"] for p in proj] == ["P"]


def test_update_bumps_version_and_keeps_id(store):
    p = store.create(name="A", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    updated = store.update(p["id"], name="A2", prompt="new")
    assert updated["id"] == p["id"]
    assert updated["name"] == "A2"
    assert updated["prompt"] == "new"
    assert updated["version"] == 2


def test_delete_removes(store):
    p = store.create(name="A", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    store.delete(p["id"])
    assert store.get(p["id"]) is None
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_preset_store.py -q` (from repo root)
Expected: FAIL (module not found). Match the existing suite's import convention — if other tests use bare `from services.X import ...`, mirror that (the fixture above uses `from backend.services...`; adjust to the project's actual style, checking `backend/tests/conftest.py` + an existing store test).

- [ ] **Step 3: Implement**

Create `backend/services/preset_store.py` mirroring `backend/services/moodboard_store.py`. Read that file first and reuse its `_write_json`, scope-dir, cross-scope find, and id-validation helpers verbatim (adapting names). The store:

```python
"""File-backed preset ("style") store. Mirrors moodboard_store / character_store.

Presets live in ~/.nebula/presets/_global/<id>.json (global) or
~/.nebula/presets/<projectId>/<id>.json (project). Override the root with
NEBULA_PRESET_ROOT (read on every call so tests can monkeypatch it).
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_GLOBAL_DIR = "_global"


def _root() -> Path:
    return Path(os.environ.get("NEBULA_PRESET_ROOT", str(Path.home() / ".nebula" / "presets")))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _scope_dir(scope: str, projectId: str | None) -> Path:
    if scope == "project" and projectId:
        if not _ID_RE.fullmatch(projectId):
            raise ValueError("invalid projectId")
        return _root() / projectId
    return _root() / _GLOBAL_DIR


def _find_file(preset_id: str) -> Path | None:
    if not _ID_RE.fullmatch(preset_id):
        return None
    root = _root()
    if not root.exists():
        return None
    for sub in root.iterdir():
        if sub.is_dir():
            candidate = sub / f"{preset_id}.json"
            if candidate.exists():
                return candidate
    return None


class PresetStore:
    _IMMUTABLE = {"id", "createdAt", "projectId"}

    def create(self, *, name: str, category: str, prompt: str, params: dict[str, Any],
               modelId: str | None, refImages: list[str], scope: str, projectId: str | None) -> dict[str, Any]:
        preset_id = uuid.uuid4().hex[:12]
        now = _now()
        preset = {
            "id": preset_id,
            "name": name,
            "category": category,
            "prompt": prompt,
            "params": dict(params or {}),
            "modelId": modelId,
            "refImages": list(refImages or []),
            "thumbnail": "",
            "version": 1,
            "scope": "project" if (scope == "project" and projectId) else "global",
            "projectId": projectId if scope == "project" else None,
            "createdAt": now,
            "updatedAt": now,
        }
        _write_json(_scope_dir(scope, projectId) / f"{preset_id}.json", preset)
        return preset

    def get(self, preset_id: str) -> dict[str, Any] | None:
        path = _find_file(preset_id)
        if not path:
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self, scope: str, projectId: str | None = None) -> list[dict[str, Any]]:
        directory = _scope_dir(scope, projectId)
        if not directory.exists():
            return []
        items = [json.loads(p.read_text(encoding="utf-8")) for p in directory.glob("*.json")]
        items.sort(key=lambda x: x.get("createdAt", ""))
        return items

    def update(self, preset_id: str, **fields: Any) -> dict[str, Any]:
        path = _find_file(preset_id)
        if not path:
            raise KeyError(preset_id)
        preset = json.loads(path.read_text(encoding="utf-8"))
        for key, value in fields.items():
            if key in self._IMMUTABLE or value is None:
                continue
            preset[key] = value
        preset["version"] = int(preset.get("version", 1)) + 1
        preset["updatedAt"] = _now()
        _write_json(path, preset)
        return preset

    def delete(self, preset_id: str) -> None:
        path = _find_file(preset_id)
        if not path:
            raise KeyError(preset_id)
        path.unlink()


preset_store = PresetStore()
```

- [ ] **Step 4: Run to verify pass**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_preset_store.py -q`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add backend/services/preset_store.py backend/tests/test_preset_store.py
git commit -m "feat(create): add file-backed preset_store"
```

### Task A2: `/api/presets` routes

**Files:**
- Modify: `backend/main.py` (add routes near `/api/moodboards`, ~line 2179)
- Test: `backend/tests/test_preset_api.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_preset_api.py` (match the import + isolation conventions used by `test_character_api.py`/`test_preset_store.py`):

```python
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import app  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_presets(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import importlib
    import services.preset_store as ps
    importlib.reload(ps)
    import main as m
    monkeypatch.setattr(m, "preset_store", ps.PresetStore())
    yield


def test_crud_flow():
    client = TestClient(app)
    created = client.post("/api/presets", json={
        "name": "Y2K Studio", "category": "Editorial", "prompt": "y2k studio flash",
        "params": {"aspect_ratio": "3:4"}, "modelId": "nano-banana", "refImages": [], "scope": "global",
    }).json()
    pid = created["id"]
    assert created["name"] == "Y2K Studio"

    listed = client.get("/api/presets?scope=global").json()
    assert any(p["id"] == pid for p in listed)

    got = client.get(f"/api/presets/{pid}").json()
    assert got["prompt"] == "y2k studio flash"

    updated = client.put(f"/api/presets/{pid}", json={"name": "Y2K Studio v2"}).json()
    assert updated["name"] == "Y2K Studio v2"

    assert client.delete(f"/api/presets/{pid}").json()["status"] == "deleted"
    assert client.get(f"/api/presets/{pid}").status_code == 404
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_preset_api.py -q`
Expected: FAIL (404s — routes not defined).

- [ ] **Step 3: Implement the routes**

In `backend/main.py`, add Pydantic models near `MoodboardCreate` (~line 1988) and routes near the moodboard routes (~line 2179). Import the store: add `from services.preset_store import preset_store` with the other service imports (match the existing import style in main.py).

```python
class PresetCreate(BaseModel):
    name: str
    category: str = "Style"
    prompt: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    modelId: str | None = None
    refImages: list[str] = Field(default_factory=list)
    scope: str = "global"
    projectId: str | None = None


class PresetUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    prompt: str | None = None
    params: dict[str, Any] | None = None
    modelId: str | None = None
    refImages: list[str] | None = None
```

```python
@app.get("/api/presets")
async def list_presets(scope: str = "global", projectId: str | None = None) -> list[dict]:
    _validate_project_id_param(projectId)
    return preset_store.list(scope, projectId)


@app.post("/api/presets")
async def create_preset(body: PresetCreate) -> dict:
    _validate_project_id_param(body.projectId)
    return preset_store.create(
        name=body.name, category=body.category, prompt=body.prompt, params=body.params,
        modelId=body.modelId, refImages=body.refImages, scope=body.scope, projectId=body.projectId,
    )


@app.get("/api/presets/{preset_id}")
async def get_preset(preset_id: str) -> dict:
    preset = preset_store.get(preset_id)
    if preset is None:
        raise HTTPException(status_code=404, detail="preset not found")
    return preset


@app.put("/api/presets/{preset_id}")
async def update_preset(preset_id: str, body: PresetUpdate) -> dict:
    try:
        return preset_store.update(preset_id, **body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(status_code=404, detail="preset not found")


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: str) -> dict:
    try:
        preset_store.delete(preset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="preset not found")
    return {"status": "deleted", "id": preset_id}
```

> `BaseModel`, `Field`, `HTTPException`, `Any`, `_validate_project_id_param` are already imported/defined in main.py. If `main.py` imports `preset_store` at module load, the test's `monkeypatch.setattr(m, "preset_store", ...)` swap works (the routes reference the module global `preset_store`).

- [ ] **Step 4: Run to verify pass**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_preset_api.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_preset_api.py
git commit -m "feat(create): add /api/presets CRUD routes"
```

### Task A3: first-run seeding

**Files:**
- Create: `backend/data/presets/seed.json`
- Modify: `backend/main.py` (seeder fn + startup call)
- Test: `backend/tests/test_preset_seed.py`

- [ ] **Step 1: Write the seed data**

Create `backend/data/presets/seed.json` — a JSON array of ~12 curated presets (no thumbnails). Each: `{name, category, prompt, params, modelId}`. Use real param keys (`aspect_ratio` values valid for nano-banana). Example (extend to ~12, varied categories):

```json
[
  {"name": "Cinematic Noir", "category": "Cinematic", "prompt": "high-contrast black-and-white film noir, dramatic chiaroscuro lighting, deep shadows, 35mm grain", "params": {"aspect_ratio": "16:9"}, "modelId": "nano-banana"},
  {"name": "Golden Hour Portrait", "category": "Portrait", "prompt": "warm golden-hour backlight, soft bokeh, intimate shallow depth of field, natural skin tones", "params": {"aspect_ratio": "3:4"}, "modelId": "nano-banana"},
  {"name": "Editorial Flash", "category": "Editorial", "prompt": "direct on-camera flash, glossy magazine editorial look, crisp shadows, high fashion", "params": {"aspect_ratio": "4:5"}, "modelId": "nano-banana"},
  {"name": "Risograph Print", "category": "Illustration", "prompt": "two-color risograph print, halftone texture, slight misregistration, muted retro palette", "params": {"aspect_ratio": "1:1"}, "modelId": "nano-banana"},
  {"name": "Studio Product", "category": "Product", "prompt": "clean studio product shot, seamless white sweep, soft gradient lighting, sharp focus, commercial", "params": {"aspect_ratio": "1:1"}, "modelId": "nano-banana"},
  {"name": "Anime Cel", "category": "Anime", "prompt": "hand-drawn anime cel style, bold linework, flat cel shading, vibrant saturated colors", "params": {"aspect_ratio": "16:9"}, "modelId": "nano-banana"},
  {"name": "Cyberpunk Neon", "category": "Sci-Fi", "prompt": "rain-slicked cyberpunk street at night, neon signage, volumetric haze, teal and magenta", "params": {"aspect_ratio": "16:9"}, "modelId": "nano-banana"},
  {"name": "Watercolor Wash", "category": "Illustration", "prompt": "loose watercolor wash, wet-on-wet blooms, soft pigment edges, paper texture", "params": {"aspect_ratio": "3:4"}, "modelId": "nano-banana"},
  {"name": "Vintage Film", "category": "Photography", "prompt": "expired 35mm film aesthetic, faded colors, light leaks, halation, nostalgic grain", "params": {"aspect_ratio": "3:2"}, "modelId": "nano-banana"},
  {"name": "Isometric Diorama", "category": "3D", "prompt": "cute isometric 3D diorama, soft clay materials, tilt-shift, pastel palette, studio lighting", "params": {"aspect_ratio": "1:1"}, "modelId": "nano-banana"},
  {"name": "Minimal Line Art", "category": "Illustration", "prompt": "single continuous black line art on white, minimal, elegant, lots of negative space", "params": {"aspect_ratio": "1:1"}, "modelId": "nano-banana"},
  {"name": "Epic Concept Art", "category": "Cinematic", "prompt": "sweeping fantasy concept art, dramatic scale, atmospheric perspective, painterly, golden rim light", "params": {"aspect_ratio": "21:9"}, "modelId": "nano-banana"}
]
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_preset_seed.py`:

```python
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as m  # noqa: E402
import services.preset_store as ps  # noqa: E402


@pytest.fixture()
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import importlib
    importlib.reload(ps)
    store = ps.PresetStore()
    monkeypatch.setattr(m, "preset_store", store)
    return store


def test_seed_populates_empty_global_then_is_idempotent(fresh):
    assert fresh.list("global") == []
    m.seed_presets_if_empty()
    seeded = fresh.list("global")
    assert len(seeded) >= 12
    names = {p["name"] for p in seeded}
    assert "Cinematic Noir" in names
    # idempotent: running again does not duplicate
    m.seed_presets_if_empty()
    assert len(fresh.list("global")) == len(seeded)


def test_seed_skips_when_not_empty(fresh):
    fresh.create(name="Mine", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    m.seed_presets_if_empty()
    names = {p["name"] for p in fresh.list("global")}
    assert names == {"Mine"}  # untouched
```

- [ ] **Step 3: Implement the seeder**

In `backend/main.py`, add (near the preset routes):

```python
_PRESET_SEED_PATH = Path(__file__).resolve().parent / "data" / "presets" / "seed.json"


def seed_presets_if_empty() -> None:
    """Populate the global preset store with shipped starter styles on first run.
    Idempotent: does nothing if any global preset already exists."""
    try:
        if preset_store.list("global"):
            return
        if not _PRESET_SEED_PATH.exists():
            return
        seeds = json.loads(_PRESET_SEED_PATH.read_text(encoding="utf-8"))
        for s in seeds:
            preset_store.create(
                name=s["name"], category=s.get("category", "Style"), prompt=s.get("prompt", ""),
                params=s.get("params", {}), modelId=s.get("modelId"), refImages=s.get("refImages", []),
                scope="global", projectId=None,
            )
    except Exception as exc:  # never let seeding break boot
        print(f"[presets] seed failed: {exc}", flush=True)
```

Call it once at startup. Find how main.py runs boot-time setup (it restores the graph at module load near line 42-61). Add `seed_presets_if_empty()` alongside that boot code (after `preset_store` is defined/imported), OR in a FastAPI `@app.on_event("startup")` / lifespan handler if the file uses one. Match the existing startup style.

> `json` and `Path` are already imported in main.py.

- [ ] **Step 4: Run to verify pass**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_preset_seed.py -q`
Expected: PASS (2).

- [ ] **Step 5: Commit**

```bash
git add backend/data/presets/seed.json backend/main.py backend/tests/test_preset_seed.py
git commit -m "feat(create): seed starter presets on first run"
```

---

## Phase B — Frontend client + apply logic

### Task B1: `Preset` type + `createPresets` client

**Files:**
- Create: `frontend/src/lib/createPresets.ts`
- Test: `frontend/tests/lib/createPresets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/lib/createPresets.test.ts`:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }));
import { fetchPresets, createPreset, deletePreset } from '../../src/lib/createPresets';

beforeEach(() => fetchMock.mockReset());

describe('createPresets client', () => {
  it('fetchPresets GETs with scope', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ id: 'p1', name: 'A' }] });
    const out = await fetchPresets('global');
    expect(out).toEqual([{ id: 'p1', name: 'A' }]);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/presets?scope=global');
  });

  it('createPreset POSTs the body', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'p2' }) });
    const out = await createPreset({ name: 'B', category: 'Style', prompt: 'x', params: {}, modelId: 'nano-banana', refImages: [], scope: 'project' });
    expect(out.id).toBe('p2');
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/presets');
    expect((init as { method: string }).method).toBe('POST');
  });

  it('deletePreset DELETEs by id and throws on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(deletePreset('nope')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd frontend && npx vitest run tests/lib/createPresets.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `frontend/src/lib/createPresets.ts`:

```typescript
import { apiFetch } from './backend';

export interface Preset {
  id: string;
  name: string;
  category: string;
  prompt: string;
  params: Record<string, unknown>;
  modelId: string | null;
  refImages: string[];
  thumbnail: string;
  version: number;
  scope: 'global' | 'project';
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PresetCreateInput = {
  name: string; category: string; prompt: string; params: Record<string, unknown>;
  modelId: string | null; refImages: string[]; scope: 'global' | 'project'; projectId?: string;
};

export async function fetchPresets(scope: 'global' | 'project', projectId?: string): Promise<Preset[]> {
  const params = new URLSearchParams({ scope });
  if (scope === 'project' && projectId) params.append('projectId', projectId);
  const res = await apiFetch(`/api/presets?${params.toString()}`);
  if (!res.ok) throw new Error(`Fetch presets failed: ${res.status}`);
  return res.json();
}

export async function createPreset(body: PresetCreateInput): Promise<Preset> {
  const res = await apiFetch('/api/presets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Create preset failed: ${res.status}`);
  return res.json();
}

export async function deletePreset(id: string): Promise<void> {
  const res = await apiFetch(`/api/presets/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete preset failed: ${res.status}`);
}
```

- [ ] **Step 4: Run to verify pass** — `cd frontend && npx vitest run tests/lib/createPresets.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/createPresets.ts frontend/tests/lib/createPresets.test.ts
git commit -m "feat(create): add presets API client + Preset type"
```

### Task B2: `applyPresetToComposer` pure merge

**Files:**
- Create: `frontend/src/lib/applyPreset.ts`
- Test: `frontend/tests/lib/applyPreset.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/lib/applyPreset.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyPresetToComposer } from '../../src/lib/applyPreset';
import type { Preset } from '../../src/lib/createPresets';

function preset(over: Partial<Preset>): Preset {
  return { id: 'p', name: 'N', category: 'C', prompt: '', params: {}, modelId: null, refImages: [],
    thumbnail: '', version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '', ...over };
}

describe('applyPresetToComposer', () => {
  it('appends the preset prompt fragment to the existing prompt', () => {
    const out = applyPresetToComposer(preset({ prompt: 'film noir lighting' }), { modelId: 'nano-banana', prompt: 'a cat', params: {} });
    expect(out.prompt).toBe('a cat, film noir lighting');
  });

  it('uses the fragment alone when the prompt is empty', () => {
    const out = applyPresetToComposer(preset({ prompt: 'noir' }), { modelId: 'nano-banana', prompt: '', params: {} });
    expect(out.prompt).toBe('noir');
  });

  it('switches model (rebuilding defaults) and overlays preset params', () => {
    const out = applyPresetToComposer(
      preset({ modelId: 'nano-banana', params: { aspect_ratio: '16:9' } }),
      { modelId: 'flux-schnell', prompt: '', params: { aspect_ratio: '1:1' } },
    );
    expect(out.modelId).toBe('nano-banana');
    expect(out.params.aspect_ratio).toBe('16:9');
    // a nano-banana default the preset didn't set is present (defaults rebuilt on model switch)
    expect(out.params.model).toBeDefined();
  });

  it('keeps current model + params when preset has no modelId', () => {
    const out = applyPresetToComposer(preset({ modelId: null, params: { imageSize: '2K' } }),
      { modelId: 'nano-banana', prompt: '', params: { aspect_ratio: '16:9' } });
    expect(out.modelId).toBe('nano-banana');
    expect(out.params.aspect_ratio).toBe('16:9'); // current kept
    expect(out.params.imageSize).toBe('2K');       // preset overlaid
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd frontend && npx vitest run tests/lib/applyPreset.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/applyPreset.ts`:

```typescript
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from './createParams';
import type { Preset } from './createPresets';

export interface ComposerState {
  modelId: string | null;
  prompt: string;
  params: Record<string, unknown>;
}

/** Merge a preset into the current composer state. Pure. */
export function applyPresetToComposer(preset: Preset, current: ComposerState): ComposerState {
  // Prompt: append the fragment to whatever the user already typed.
  const fragment = preset.prompt.trim();
  const base = current.prompt.trim();
  const prompt = fragment && base ? `${base}, ${fragment}` : fragment || base;

  // Model: if the preset hints a model (and it exists), switch to it and rebuild
  // its defaults so stale params from the old model don't leak through.
  let modelId = current.modelId;
  let baseParams = current.params;
  if (preset.modelId && NODE_DEFINITIONS[preset.modelId]) {
    modelId = preset.modelId;
    baseParams = buildDefaultParamsForUi(NODE_DEFINITIONS[preset.modelId]);
  }

  return { modelId, prompt, params: { ...baseParams, ...preset.params } };
}
```

- [ ] **Step 4: Run to verify pass** — `cd frontend && npx vitest run tests/lib/applyPreset.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/applyPreset.ts frontend/tests/lib/applyPreset.test.ts
git commit -m "feat(create): add applyPresetToComposer pure merge"
```

---

## Phase C — Preset library UI

### Task C1: `PresetCard`

**Files:**
- Create: `frontend/src/components/create-studio/PresetCard.tsx`

- [ ] **Step 1: Implement**

Create `frontend/src/components/create-studio/PresetCard.tsx`:

```tsx
import type { Preset } from '../../lib/createPresets';

// Deterministic hue from the preset id so each card gets a stable gradient.
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function PresetCard({ preset, onApply }: { preset: Preset; onApply: (p: Preset) => void }) {
  const hue = hueOf(preset.id);
  return (
    <button
      type="button"
      className="preset-card"
      onClick={() => onApply(preset)}
      style={{ ['--preset-hue' as string]: `${hue}` }}
      title={preset.prompt}
    >
      {preset.thumbnail ? (
        <img className="preset-card__thumb" src={preset.thumbnail} alt="" />
      ) : (
        <span className="preset-card__gradient" aria-hidden="true" />
      )}
      <span className="preset-card__name">{preset.name}</span>
      <span className="preset-card__category">{preset.category}</span>
    </button>
  );
}
```

> Inline `style` here sets a dynamic CSS custom property (the per-card hue) — this is a dynamic data value, not a static visual style, so it is allowed by `check:inline-styles`. All actual visual styling lives in CSS.

- [ ] **Step 2: Type-check** — `cd frontend && npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/PresetCard.tsx
git commit -m "feat(create): add typographic PresetCard"
```

### Task C2: `PresetLibrary`

**Files:**
- Create: `frontend/src/components/create-studio/PresetLibrary.tsx`

- [ ] **Step 1: Implement**

Create `frontend/src/components/create-studio/PresetLibrary.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Search, Bookmark } from 'lucide-react';
import { fetchPresets, type Preset } from '../../lib/createPresets';
import { PresetCard } from './PresetCard';

export interface PresetLibraryProps {
  onApply: (preset: Preset) => void;
  onSaveCurrent: () => void;
  onClose: () => void;
  reloadKey: number; // bump to refetch after a save
}

export function PresetLibrary({ onApply, onSaveCurrent, onClose, reloadKey }: PresetLibraryProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPresets('global'), fetchPresets('project')])
      .then(([g, p]) => { if (!cancelled) setPresets([...p, ...g]); })
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(presets.map((p) => p.category))).sort()],
    [presets],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return presets.filter((p) =>
      (category === 'All' || p.category === category) &&
      (!q || p.name.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)),
    );
  }, [presets, query, category]);

  return (
    <div className="preset-library" role="dialog" aria-label="Styles">
      <div className="preset-library__top">
        <div className="preset-library__search">
          <Search size={15} strokeWidth={1.75} aria-hidden="true" />
          <input autoFocus type="text" placeholder="Search styles…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="button" className="preset-library__save" onClick={onSaveCurrent}>
          <Bookmark size={14} strokeWidth={1.75} aria-hidden="true" /> Save current
        </button>
      </div>
      <div className="preset-library__cats">
        {categories.map((c) => (
          <button key={c} type="button" className={`preset-library__cat${category === c ? ' is-active' : ''}`} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      <div className="preset-library__grid">
        {visible.map((p) => <PresetCard key={p.id} preset={p} onApply={(pp) => { onApply(pp); onClose(); }} />)}
        {visible.length === 0 && <div className="preset-library__empty">No styles yet.</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check** — clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/PresetLibrary.tsx
git commit -m "feat(create): add PresetLibrary popover (search, categories, save)"
```

### Task C3: composer "Styles" button + CreateView wiring

**Files:**
- Modify: `frontend/src/components/create-studio/CreateComposer.tsx`
- Modify: `frontend/src/components/create-studio/CreateView.tsx`

- [ ] **Step 1: Add a "Styles" trigger to the composer**

In `CreateComposer.tsx`, add prop `onOpenStyles: () => void;` and render a button in `.create-composer__controls` (next to the model pill):

```tsx
        <button type="button" className="create-composer__styles" onClick={onOpenStyles} title="Browse styles">
          Styles
        </button>
```

- [ ] **Step 2: Wire the library + apply + save in `CreateView`**

In `CreateView.tsx`:
- Imports: `import { PresetLibrary } from './PresetLibrary';`, `import { applyPresetToComposer } from '../../lib/applyPreset';`, `import { createPreset, type Preset } from '../../lib/createPresets';`.
- State: `const [stylesOpen, setStylesOpen] = useState(false);` and `const [presetReloadKey, setPresetReloadKey] = useState(0);`.
- Apply handler:

```tsx
  const handleApplyPreset = (preset: Preset) => {
    const next = applyPresetToComposer(preset, { modelId, prompt, params });
    if (next.modelId && next.modelId !== modelId) setModelId(next.modelId);
    setPrompt(next.prompt);
    setParams(next.params);
    if (preset.refImages.length > 0) {
      setRefs((prev) => {
        const add = preset.refImages
          .filter((fp) => !prev.some((r) => r.filePath === fp))
          .map((fp) => ({ filePath: fp, previewUrl: fp }));
        return [...prev, ...add];
      });
    }
  };
```

- Save-current handler:

```tsx
  const handleSaveCurrentStyle = async () => {
    if (!modelDef) return;
    const name = window.prompt('Name this style:', prompt.slice(0, 40) || modelDef.displayName);
    if (!name) return;
    try {
      await createPreset({ name, category: 'My Styles', prompt, params, modelId: modelDef.id, refImages: refs.map((r) => r.filePath), scope: 'project' });
      setPresetReloadKey((k) => k + 1);
    } catch (err) { console.error('save style failed', err); }
  };
```

- Render the library when open (as an overlay above the composer), and pass `onOpenStyles={() => setStylesOpen(true)}` to `CreateComposer`:

```tsx
      {stylesOpen && (
        <PresetLibrary
          onApply={handleApplyPreset}
          onSaveCurrent={handleSaveCurrentStyle}
          onClose={() => setStylesOpen(false)}
          reloadKey={presetReloadKey}
        />
      )}
```

- [ ] **Step 3: Type-check + lint** — `cd frontend && npx tsc --noEmit && npx eslint src/components/create-studio src/lib/createPresets.ts src/lib/applyPreset.ts` → clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/create-studio/CreateComposer.tsx frontend/src/components/create-studio/CreateView.tsx
git commit -m "feat(create): wire Styles library, apply-preset, save-current-as-style"
```

### Task C4: preset library + card CSS

**Files:**
- Modify: `frontend/src/styles/create-gallery.css`

- [ ] **Step 1: Add styles (all under `body.app-slava-restraint`)**

Append to `frontend/src/styles/create-gallery.css`:

```css
body.app-slava-restraint .create-composer__styles {
  background: var(--sr-glass-raised);
  border: 1px solid var(--sr-edge);
  border-radius: 10px;
  padding: 7px 12px;
  color: var(--sr-ink);
  font-size: 13px;
  cursor: pointer;
}
body.app-slava-restraint .create-composer__styles:hover { border-color: var(--sr-edge-strong); }

body.app-slava-restraint .preset-library {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  width: min(680px, calc(100vw - 48px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--sr-glass-strong);
  border: 1px solid var(--sr-edge-strong);
  border-radius: 16px;
  backdrop-filter: blur(18px);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  z-index: 60;
  overflow: hidden;
}
body.app-slava-restraint .preset-library__top { display: flex; gap: 8px; padding: 12px; border-bottom: 1px solid var(--sr-edge); }
body.app-slava-restraint .preset-library__search { flex: 1; display: flex; align-items: center; gap: 8px; color: var(--sr-ink-meta); }
body.app-slava-restraint .preset-library__search input { flex: 1; background: transparent; border: none; outline: none; color: var(--sr-ink); font-family: inherit; font-size: 13px; }
body.app-slava-restraint .preset-library__save { display: inline-flex; align-items: center; gap: 6px; background: var(--sr-glass-raised); border: 1px solid var(--sr-edge); border-radius: 9px; padding: 6px 10px; color: var(--sr-ink); font-size: 12px; cursor: pointer; }
body.app-slava-restraint .preset-library__cats { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--sr-edge); }
body.app-slava-restraint .preset-library__cat { background: transparent; border: 1px solid var(--sr-edge); border-radius: 999px; padding: 4px 11px; color: var(--sr-ink-meta); font-size: 12px; cursor: pointer; }
body.app-slava-restraint .preset-library__cat.is-active { border-color: var(--sr-accent); color: var(--sr-ink-bold); }
body.app-slava-restraint .preset-library__grid { overflow-y: auto; padding: 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
body.app-slava-restraint .preset-library__empty { grid-column: 1 / -1; text-align: center; color: var(--sr-ink-faint); padding: 28px 0; font-size: 13px; }

body.app-slava-restraint .preset-card {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  aspect-ratio: 4 / 3;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--sr-edge);
  background: var(--sr-glass);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
}
body.app-slava-restraint .preset-card__gradient,
body.app-slava-restraint .preset-card__thumb {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0;
}
body.app-slava-restraint .preset-card__gradient {
  background: linear-gradient(150deg,
    hsl(var(--preset-hue, 20) 55% 22%) 0%,
    hsl(calc(var(--preset-hue, 20) + 40) 45% 12%) 100%);
}
body.app-slava-restraint .preset-card::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.6), transparent 60%); z-index: 1; }
body.app-slava-restraint .preset-card__name { position: relative; z-index: 2; color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
body.app-slava-restraint .preset-card__category { position: relative; z-index: 2; color: rgba(255,255,255,0.7); font-size: 11px; }
body.app-slava-restraint .preset-card:hover { border-color: var(--sr-accent); }
```

> Confirm each `--sr-*` token exists in `slava-restraint.css`; substitute the nearest existing token for any that don't (don't invent globals).

- [ ] **Step 2: Lint** — `cd frontend && npm run check:slava-css-scope` → pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/create-gallery.css
git commit -m "feat(create): preset library + card styles"
```

---

## Phase D — Full gate (no new code)

### Task D1: full suites + build

- [ ] Run every gate; all must pass:

```bash
backend/.venv/bin/python -m pytest backend/tests -q     # all pass (incl. new preset tests)
cd frontend && npx tsc --noEmit
cd frontend && npx vitest run
cd frontend && npm run build
cd frontend && npx eslint src/components/create-studio src/lib/createPresets.ts src/lib/applyPreset.ts
cd frontend && npm run check:slava-css-scope
```

- [ ] If anything fails, fix before proceeding to the live smoke (which is the shared P2+P3 verification step in the parent workflow).

---

## Self-Review

- **Spec coverage (§6.5):** preset data model (B1) ✓; backend store (A1) ✓; `/api/presets` routes (A2) ✓; seeded starter set (A3) ✓; PresetLibrary UI with search + category filter (C2) ✓; PresetCard merchandising (C1, typographic — thumbnails deferred to P4, logged) ✓; apply pre-fills composer (B2 + C3) ✓; save-current-as-style (C3) ✓.
- **Placeholder scan:** none. The "match the existing import convention" / "confirm `--sr-*` tokens" notes are explicit verification steps. Seed JSON is real (12 entries).
- **Type consistency:** `Preset` (B1) is the single source used by `applyPreset` (B2), `PresetCard`/`PresetLibrary` (C1/C2), and `CreateView` (C3). `applyPresetToComposer(preset, {modelId, prompt, params})` (B2) matches the call site (C3). `createPreset(PresetCreateInput)` (B1) matches `handleSaveCurrentStyle` (C3). Backend `PresetCreate`/`PresetUpdate` fields mirror `preset_store.create`/`update` kwargs.
- **Risk:** all additive — new store/routes/files; `main.py` gains routes + a guarded startup seeder (wrapped in try/except so it can never break boot); no existing route touched. Typographic cards need no static-serving change.
