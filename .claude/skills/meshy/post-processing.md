# Post-Processing — Remesh, Retexture, Rigging, Animation, 3D Print

Sourced from docs.meshy.ai (fetched 2026-04-17). Every param verified.

All endpoints follow the same async pattern: `POST` returns `{"result": "<task_id>"}`, `GET /{endpoint}/{task_id}` polls, `SSE /{endpoint}/{task_id}/stream` streams.

---

## Remesh (`/openapi/v1/remesh`)

Takes an existing 3D model and does **decimation + format conversion + optional quad retopology + resizing**. 5 credits.

### What remesh IS
- Polygon reduction (down to target count or adaptive level)
- Format conversion (GLB, FBX, OBJ, USDZ, BLEND, STL, 3MF)
- Quad or triangle topology
- Resizing by real-world height (manual or AI-estimated)

### What remesh IS NOT
- Not topology cleanup (doesn't fix non-manifold geometry)
- Not watertight-mesh repair
- Not edge-flow optimization for animation
- Not degenerate face removal

For AI-generated mesh cleanup, use external tools like Blender's OpenVDB voxel remesh.

### Parameters

**Input source (one required):**
| Param | Type | Notes |
|---|---|---|
| `input_task_id` | string | ID of a SUCCEEDED **Text-to-3D Preview, Text-to-3D Refine, Image-to-3D, or Retexture** task. **Takes priority over `model_url` if both provided.** |
| `model_url` | string | Public URL or data URI (`application/octet-stream`). Input formats: `.glb`, `.gltf`, `.obj`, `.fbx`, `.stl` |

**Core params:**
| Param | Type | Default | Notes |
|---|---|---|---|
| `target_formats` | string[] | `["glb"]` | Available: `"glb"`, `"fbx"`, `"obj"`, `"usdz"`, `"blend"`, `"stl"`, `"3mf"`. **Default is GLB only** when omitted (different from text-to-3d) |
| `topology` | string | `"triangle"` | `"quad"` (quad-dominant) or `"triangle"` (decimated) |
| `target_polycount` | integer | `30000` | Range **100–300,000**. Actual may deviate |
| `decimation_mode` | integer | — | `1` (ultra), `2` (high), `3` (medium), `4` (low). Overrides `target_polycount` |
| `resize_height` | number | `0` | Height in **meters**. **Mutually exclusive with `auto_size`** |
| `auto_size` | boolean | `false` | AI-estimated real-world height + resize. **Cannot be combined with `resize_height`** |
| `origin_at` | string | `"bottom"` | `"bottom"` or `"center"`. Only applies when `auto_size=true` |
| `convert_format_only` | boolean | — | If `true`, only converts format — ignores `topology`, `resize_height`, `target_polycount`. Requires `target_formats` |

### Response

```json
{
  "id": "...",
  "type": "remesh",
  "model_urls": {"glb": "...", "fbx": "...", ...},
  "progress": 0-100,
  "status": "PENDING|IN_PROGRESS|SUCCEEDED|FAILED",
  "task_error": {"message": "..."}
}
```

---

## Retexture (`/openapi/v1/retexture`)

Generates a new texture for an existing 3D model using text or reference image. 10 credits.

### Parameters

**Input model (one required):**
| Param | Type | Notes |
|---|---|---|
| `input_task_id` | string | SUCCEEDED Text-to-3D (preview/refine), Image-to-3D, or Remesh task. Takes priority over `model_url` |
| `model_url` | string | Public URL or data URI. Input formats: `.glb`, `.gltf`, `.obj`, `.fbx`, `.stl` |

**Style input (one required):**
| Param | Type | Notes |
|---|---|---|
| `text_style_prompt` | string | Max **600 chars**. Describe the target texture |
| `image_style_url` | string | Public URL or data URI. Input image formats: `.jpg`, `.jpeg`, `.png` |

**If both styles are given, `image_style_url` takes priority** (opposite of Image-to-3D's texture logic — careful!).

**Other params:**
| Param | Type | Default | Notes |
|---|---|---|---|
| `ai_model` | string | `"latest"` | `"meshy-5"`, `"meshy-6"`, `"latest"` |
| `enable_original_uv` | boolean | `true` | Preserve existing textures from the uploaded model |
| `enable_pbr` | boolean | `false` | Metallic + roughness + normal maps |
| `remove_lighting` | boolean | `true` | Remove baked highlights/shadows. **`meshy-6`/`latest` only** |
| `target_formats` | string[] | all except `3mf` | Same options as other endpoints |

### Limitations from docs
- *"If the uploaded model lacks UV mapping, the quality of the output might not be as good"*
- *"Image texturing may not work optimally if there are substantial geometry differences"* — style image should be roughly the same silhouette

### Response

Same task envelope as other endpoints. Output contains `model_urls` + `texture_urls` (array of PBR maps).

---

## Rigging (`/openapi/v1/rigging`)

Auto-rigs a **textured humanoid** character with a bipedal skeleton. Includes free walking + running animations. 5 credits.

### Parameters

**Input model (one required):**
| Param | Type | Notes |
|---|---|---|
| `input_task_id` | string | Task ID of the model to rig. Takes priority over `model_url` |
| `model_url` | string | Public URL or data URI of a **GLB file** |

**Optional:**
| Param | Type | Default | Notes |
|---|---|---|---|
| `height_meters` | number | `1.7` | Character height. Must be positive. More accurate = better rig |
| `texture_image_url` | string | — | UV-unwrapped base color texture (PNG). Use when supplying `model_url` without baked textures |

### Requirements (from docs)

- **Textured humanoid models only** — bipedal assets with clearly defined limbs and body structure
- **Max 300,000 faces** when using `input_task_id` — use remesh first if over
- Input: `.glb` format only
- Output: `.fbx` and `.glb`
- **NOT suitable for:** untextured meshes, non-humanoid assets, anything with unclear limb structure

### Response — successful rig

```json
{
  "id": "...",
  "type": "rig",
  "status": "SUCCEEDED",
  "progress": 100,
  "result": {
    "rigged_character_fbx_url": "...",
    "rigged_character_glb_url": "...",
    "basic_animations": {
      "walking_glb_url": "...",
      "walking_fbx_url": "...",
      "walking_armature_glb_url": "...",
      "running_glb_url": "...",
      "running_fbx_url": "...",
      "running_armature_glb_url": "..."
    }
  }
}
```

### Failure mode to watch

**`422 Unprocessable Entity` with message `"Pose estimation failed"`** — model isn't a valid humanoid. Common causes:
- Non-standard proportions (chibi characters, stylized creatures)
- Fused limbs or torso
- Missing or hidden hands/feet
- Four-legged creatures, quadrupeds, animals
- Abstract / geometric characters

No workaround — Meshy rigging requires standard bipedal humanoid structure. Use a different rigging tool or generate the model with explicit humanoid pose.

### Credit note

Rigging costs 5 credits and **includes walking + running**. Custom animations via the Animation API cost 3 credits each.

---

## Animation (`/openapi/v1/animations`)

Applies a pre-built animation (from Meshy's library of 580+ actions) to a rigged character. 3 credits.

### Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `rig_task_id` | string | ✅ | — | ID of a SUCCEEDED rigging task |
| `action_id` | integer | ✅ | — | Animation action ID. See `reference/animation-library.md` for all 580+ IDs |
| `post_process.operation_type` | string | | — | `"change_fps"`, `"fbx2usdz"`, or `"extract_armature"` |
| `post_process.fps` | integer | | `30` | Target frame rate. Allowed: `24`, `25`, `30`, `60`. Only when `operation_type="change_fps"` |

### Post-processing options

- **`change_fps`** — re-export at 24/25/30/60 fps. Output: `processed_animation_fps_fbx_url`
- **`fbx2usdz`** — convert to USDZ (great for iOS/AR). Output: `processed_usdz_url`
- **`extract_armature`** — pull just the skeleton. Output: `processed_armature_fbx_url`

### Response

```json
{
  "id": "...",
  "type": "animate",
  "status": "SUCCEEDED",
  "result": {
    "animation_glb_url": "...",
    "animation_fbx_url": "...",
    "processed_usdz_url": "...",            // if fbx2usdz
    "processed_armature_fbx_url": "...",    // if extract_armature
    "processed_animation_fps_fbx_url": "..."// if change_fps
  }
}
```

### Finding an action_id

The Animation Library has 580+ entries grouped into categories:
- **DailyActions** — Idle, LookingAround, Interacting, Sleeping, PickingUpItem, Transitioning, WorkingOut, Pushing, Drinking
- **WalkAndRun** — Walking, Running, CrouchWalking, Swimming, TurningAround
- **BodyMovements** — Acting, Climbing, PerformingStunt, Jumping, HangingfromLedge, FallingFreely, VaultingOverObstacle
- **Fighting** — Punching, AttackingwithWeapon, Blocking, Transitioning, CastingSpell, GettingHit, Dying
- **Dancing** — Dancing

Full list with IDs: `reference/animation-library.md`.

Pick an `action_id` whose name clearly matches the intended motion. E.g. `0` = Idle, `13` = Jump_Run, `83` = Shake_It_Off_Dance, `92` = Double_Combo_Attack, `395` = Breakdance_1990.

---

## 3D Print Multi-Color (`/openapi/v1/print/multi-color`)

Converts a Meshy-generated 3D model into a **multi-color 3MF** file for 3D printing. Quantizes textures into a color palette via a quadtree. 10 credits.

### Parameters

| Param | Type | Required | Default | Range | Notes |
|---|---|---|---|---|---|
| `input_task_id` | string | ✅ | — | — | SUCCEEDED task from Image-to-3D, Multi-Image-to-3D, Text-to-3D, Remesh, or Retexture |
| `max_colors` | integer | | `4` | 1–16 | Max palette size |
| `max_depth` | integer | | `4` | 3–6 | Quadtree depth. Higher = finer color boundaries + larger file |

### Response

```json
{
  "id": "...",
  "type": "print-multi-color",
  "model_urls": {"3mf": "https://.../model.3mf?Expires=..."},
  "status": "SUCCEEDED",
  "progress": 100
}
```

### Using the output

Open the `.3mf` file in a slicer that supports multi-color printing:
- Bambu Studio
- OrcaSlicer
- Creality Print
- Elegoo Slicer
- Ultimaker Cura
- Lychee Slicer

Docs include setup guides for each under `docs.meshy.ai/en/3d-printing/*`.

### Tips

- Start with defaults (`max_colors: 4`, `max_depth: 4`)
- Increase `max_depth` only if you see color banding — file size grows
- Limit `max_colors` to match your printer's AMS/filament slots (Bambu X1C with 4 slots → `max_colors: 4`)

---

## Chaining tasks — patterns worth knowing

**Input chaining** lets you avoid re-uploading models. Most endpoints accept `input_task_id` from a prior Meshy task:

```
text-to-3d preview  →  task_A
text-to-3d refine   →  task_B   (preview_task_id=task_A)
retexture           →  task_C   (input_task_id=task_B)
remesh              →  task_D   (input_task_id=task_C)
rigging             →  task_E   (input_task_id=task_D)
animate             →  task_F   (rig_task_id=task_E, action_id=42)
3d-print multi      →  task_G   (input_task_id=task_B or C or D)
```

Advantages:
- No re-upload, no file handling
- Every task in the chain stays in your dashboard history
- Reduces data transfer and latency
- Rigging + 3D print both require `input_task_id` chains (model must exist in Meshy's system)

**What does NOT accept `input_task_id`:** `text-to-3d preview` (starts fresh), `image-to-3d`, `multi-image-to-3d`, `text-to-image`, `image-to-image`.

## Rate limits to keep in mind

Queue-tasks limit is **per account** and applies to Text-to-3D, Image-to-3D, Text-to-Texture (retexture), and Remesh endpoints. Pro = 10 concurrent, Studio = 20, Enterprise = 50+. Rigging, Animation, 3D Print, and 2D image endpoints don't count toward the queue limit. Full details: `reference/rate-limits.md`.
