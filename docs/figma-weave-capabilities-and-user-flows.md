# Figma Weave: capability and user-flow baseline

> Research date: 2026-08-17. Purpose: establish a source-backed Figma Weave baseline before comparing it with Nebula Nodes. Scope: Figma Weave only; this document deliberately does **not** score Nebula parity or recommend implementation work.

## Executive summary

Figma Weave is currently a family of related surfaces rather than one fully unified product:

1. **Figma Weave standalone** — the node-based creative workflow canvas at `weave.figma.com` / `app.weavy.ai`.
2. **Weave tools in Figma Design** — 20+ Figma-curated image tasks exposed as simple tools in Figma Design's left panel.
3. **Weave workflows in Figma Community** — public, discoverable workflow templates that users can duplicate into Weave.
4. **Weave tools through Figma MCP** — paid standalone users can let an external agent discover and run their published tools.
5. **The Figma node in Weave** — announced and demonstrated, but no current primary source found in this research confirms that it has shipped.

The standalone product's central abstraction is an inspectable, typed node graph. Users combine model nodes with prompts, media, data types, iterators, masks, editing operations, compositing, timelines, comparison, and output nodes. A completed graph can remain an editable workflow, become a simplified reusable **tool**, be shared as a link, or be published as a Figma Community template.

The model catalog spans image generation and editing, video generation and transformation, enhancement, lip sync/avatar output, 3D generation, and vectors. Audio is supported as imported and composited media, as lip-sync input, and as generated or preserved output in some video models. The public help center does not currently expose a separate audio-generation model comparison family.

## 1. Scope, terminology, and status rules

### 1.1 Product naming

- **Weavy** was acquired by Figma in October 2025 and is now **Figma Weave**.
- The product, help-center URLs, and application URLs still contain `weavy.ai` in places. Those URLs are treated as official Figma Weave sources, not as a separate product.
- A **workflow** is the editable node graph.
- A **tool** (formerly “Design App”) is a simplified, parameterized interface generated from a workflow.
- A Figma **Weave tool** is a curated tool that runs inside Figma Design. It is not the same thing as an arbitrary standalone tool link.
- A **Community workflow** is a public workflow template that another user can discover and duplicate.

Sources: [Figma Weave FAQ](https://help.weavy.ai/en/articles/12692387-figma-weave-faq), [Tools](https://help.weavy.ai/en/articles/12267755-tools), [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/).

### 1.2 Status vocabulary used here

| Status | Meaning |
|---|---|
| **Live** | Current official help or product documentation describes the user flow as available. |
| **Open beta** | Available, but Figma explicitly calls it beta and says commercial behavior may change. |
| **Announced** | Figma previewed or promised the capability, but current live documentation was not found. |
| **Documented limitation** | Figma explicitly says the capability is absent or constrained. |
| **Not established** | No authoritative source found; this is not proof that the capability does not exist. |

### 1.3 Current surface/status matrix

| Surface or capability | Status on 2026-08-17 | Important boundary |
|---|---|---|
| Standalone Weave node canvas | **Live** | Separate account, plans, billing, credits, and workspace state from core Figma. |
| Curated Weave tools in Figma Design | **Live, open beta** | Professional, Organization, or Enterprise plan; user needs `can edit`; free during beta, later expected to consume Figma AI credits. |
| Open a Figma Weave tool's underlying workflow | **Live** | Opens standalone Weave and consumes standalone Weave credits when run there. |
| Publish/discover Weave workflows in Figma Community | **Live** | Community publishing creates a duplicable workflow template, not automatic inclusion in Figma Design's curated Tools panel. |
| Run a standalone Weave tool through Figma MCP | **Live** | Starter, Professional, Team, or Enterprise Weave plan; uses Weave credits; run-only, not workflow authoring. |
| Figma frame as a live node in Weave | **Announced** | June 24 source called it “upcoming” and expected it later in summer; no later primary source confirming launch was found. |
| Any creator publishing a custom tool directly into Figma Design's tool surface | **Announced** | Figma's launch post said “soon”; current Figma help describes the in-product collection as Figma-curated. |

Sources: [Use Weave tools in Figma](https://help.figma.com/hc/en-us/articles/40779260614935-Use-Weave-tools-in-Figma), [publish to Figma Community](https://help.weavy.ai/en/articles/15624624-publish-weave-workflows-to-the-figma-community), [external agents/MCP](https://help.weavy.ai/en/articles/16202764-running-weave-tools-from-external-agents-mcp), [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/).

## 2. Product and information architecture

### 2.1 Dashboard and workspaces

The dashboard supports:

- Creating a blank file.
- Duplicating a shared file into an editable copy.
- Creating folders from the workspace context menu.
- Moving files by drag-and-drop or the **Move** action.
- Choosing or changing a file cover image/thumbnail.
- Sharing files with specific people, a workspace, or anyone with the link.
- Moving a file to trash, retaining it for 30 days, and restoring it.
- Switching between personal and team workspaces.
- On Enterprise, browsing all workspace members' files in a read-only **Workspace Files** view.

Sources: [Creating files](https://help.weavy.ai/en/articles/12292303-creating-files), [folders](https://help.weavy.ai/en/articles/12943563-creating-and-arranging-folders), [sharing](https://help.weavy.ai/en/articles/12944804-sharing-files), [workflow trash](https://help.weavy.ai/en/articles/14688405-workflow-trash), [switching workspaces](https://help.weavy.ai/en/articles/12292496-switching-workspaces), [file collaboration](https://help.weavy.ai/en/articles/13387857-file-collaboration).

### 2.2 Workflow editor regions

The documented editor is organized around:

- An infinite/open canvas for nodes and groups.
- A left-side toolbox and **Saved** library.
- A right-side properties panel for the selected node/model.
- A workflow-editing view and, after an Output node is added, a simplified **Tool** view.
- A media gallery/preview experience attached to result nodes.
- A Compositor editing surface with a layer panel, assets panel, and optional timeline.
- The Weave menu for preferences and workflow version history.

### 2.3 Core object model

| Object | Role |
|---|---|
| Workflow file | Saved editable graph and its media/generation history. |
| Node | Operation, model, value, media source, helper, iterator, edit, or output. |
| Port/handle | Typed input or output connector. |
| Edge/wire | Carries typed data between compatible ports. |
| Generation/result | One or more outputs retained inside a node. |
| Group | Movable, resizable, named, colored collection of nodes. |
| Saved item | Workspace-reusable model preset, node preset, or node group. |
| Tool | Simplified runnable interface derived from an Output-terminated workflow. |
| Tool version | Timestamped immutable published snapshot of a tool. |
| Workflow version | Autosaved historical state that can be restored or duplicated. |
| Community workflow | Public template that can be discovered and duplicated. |

## 3. Graph authoring and execution

### 3.1 Adding and configuring nodes

Users can add nodes through the toolbox, `Tab` search, or the canvas context menu. Selecting a model node exposes its parameters in the right panel. Inputs may be mandatory or optional, and model-specific settings include values such as aspect ratio, resolution, duration, seed, negative prompt, reference media, camera controls, LoRA strength, and output format.

There are two execution classes:

- **Generative/model nodes** expose **Run** and consume credits.
- **Non-generative tools/helpers** perform workflow processing without consuming model credits.

The current cost appears on the selected node and on model hover in the toolbox. Cost can change with settings such as duration and resolution.

Source: [Understanding nodes](https://help.weavy.ai/en/articles/12292386-understanding-nodes), [credit system](https://help.weavy.ai/en/articles/12267166-figma-weave-s-credit-system).

### 3.2 Typed wiring

- Inputs are on the left; outputs are on the right.
- Handles are type-aware; incompatible connections are rejected.
- Dropping a wire on empty canvas opens a compatible-node menu.
- Holding `Option/Alt` while dropping a wire opens node suggestions and auto-connects the chosen node.
- Dropping it on a node routes it to a relevant available input.
- Inputs are assigned in order when a target has multiple compatible slots.
- Multi-input nodes can grow new input slots.
- Users can connect a selected set of nodes together in one operation.
- Holding `Shift` while dragging can connect to multiple nodes by hover.
- Double-clicking a text handle creates and connects a Prompt node.
- A wire can be removed by right-clicking it and pressing Delete, by double-clicking it, or as part of a multi-wire box selection.
- A Router node fans one input out to multiple downstream branches.
- Global wire rendering can be Elbow, Line, or Bezier.

Documented type colors include image (green), text (purple), video (red), LoRA (purple), array/list/3D (blue), multi-input (white), and mask (lime).

Sources: [Connecting edges](https://help.weavy.ai/en/articles/14688276-connecting-edges-wires), [Deleting edges](https://help.weavy.ai/en/articles/14655207-deleting-edges-wires), [Delights #4](https://help.weavy.ai/en/articles/15263628-new-figma-weave-delights-4), [Helpers overview](https://help.weavy.ai/en/articles/12268300-helpers-overview), [wire styles](https://help.weavy.ai/en/articles/14047607-changing-wire-styles).

### 3.3 Canvas manipulation and keyboard flows

- Pan with hand mode, mouse/trackpad, or the `H` shortcut.
- Zoom with `Cmd/Ctrl` + scroll or trackpad pinch.
- Select with `V`; box-select or Shift-select multiple nodes.
- Copy/paste, duplicate, undo/redo, delete, and import are keyboard accessible.
- `Cmd/Ctrl+P` creates a Prompt node; `Cmd/Ctrl+I` imports media.
- Text nodes can be widened or enlarged by dragging their edge.
- `Cmd/Ctrl+Shift+D` or `Alt`-drag duplicates nodes while retaining connections.
- `Shift+Delete` removes a node while maintaining the surrounding flow where possible.
- Multiple results can be unpacked into separate grouped nodes or converted into an iterator.

Sources: [Navigating the canvas](https://help.weavy.ai/en/articles/12292356-navigating-the-canvas), [keyboard shortcuts](https://help.weavy.ai/en/articles/14688389-keyboard-shortcuts), [resizing text nodes](https://help.weavy.ai/en/articles/14654816-resizing-a-text-node), [Delights #2](https://help.weavy.ai/en/articles/14878372-new-figma-weave-delights-2), [Delights #3](https://help.weavy.ai/en/articles/15068263-new-figma-weave-delights-3).

### 3.4 Groups and annotations

- Group selected nodes with `Cmd/Ctrl+G` or the context menu.
- Move the group as a unit and resize it to fit its contents.
- Add a group title; adjust title size and group color.
- Remove a node from a group or ungroup the selection.
- Add sticky notes for instructions, decisions, or collaboration context; notes support text sizing and colors.

Sources: [Group and ungroup](https://help.weavy.ai/en/articles/13560959-group-and-ungroup-nodes), [Sticky notes](https://help.weavy.ai/en/articles/14046539-sticky-notes).

### 3.5 Result inspection and provenance

- A node can retain multiple generations.
- The media gallery opens in full-screen from its icon or with `Space`.
- **Show info** exposes generation history including prompt, model settings/parameters, and seed.
- Users can make a particular result current, remove the current result, or keep the current result and remove the other generations.
- A result can become the workflow cover image; Compositor output requires a Preview node before it can be selected as the cover.
- The Compare node accepts two images and supports slider or toggle comparison; the selected output can continue downstream.

Sources: [Media gallery](https://help.weavy.ai/en/articles/12292408-media-gallery), [removing media](https://help.weavy.ai/en/articles/12968045-removing-a-file-from-a-node), [cover image](https://help.weavy.ai/en/articles/12943508-creating-or-changing-a-cover-image-thumbnail), [Compare node](https://help.weavy.ai/en/articles/14046860-compare-node).

## 4. Media input, output, and asset handling

### 4.1 Import

Users can upload through an Import node, drag files onto the canvas, drop files into a node, paste an image, or paste a supported URL. Multiple dropped files become separate canvas items; an Import node can also hold a grouped collection with name/date sorting and single/gallery views.

Documented formats and limits:

| Media | Formats | General import limit |
|---|---|---|
| Image | JPEG, JPG, PNG, HEIC, WEBP | 1 GB |
| Video | MP4, QuickTime/MOV | 20 GB |
| Audio | MP3, WAV, OGG | Not stated in the public limit article |
| 3D | GLB only | Not stated in the public limit article |

Direct import from Google Drive or iCloud is not supported. Individual models can impose smaller dimensions, sizes, formats, or durations than the general importer.

Sources: [Helpers overview](https://help.weavy.ai/en/articles/12268300-helpers-overview), [working with media](https://help.weavy.ai/en/articles/14653652-working-with-media), [import limits](https://help.weavy.ai/en/articles/12414427-what-is-the-size-limit-for-imported-files), [3D support FAQ](https://help.weavy.ai/en/articles/12343740-what-kinds-of-3d-models-does-figma-weave-support).

### 4.2 Preview, download, and export

- Preview nodes display generated images or video in a clean result node.
- Export nodes download image or video output and preserve the generated file format.
- Users can download the current result, every result in one node, all results in a group, or all results from a multi-node selection.
- The Compositor can directly ingest image, video, and audio assets through drag/drop, paste, or its Assets panel.

Sources: [Helpers overview](https://help.weavy.ai/en/articles/12268300-helpers-overview), [Downloading media](https://help.weavy.ai/en/articles/14654565-downloading-media), [Compositor](https://help.weavy.ai/en/articles/15887786-compositor-node).

## 5. Text, prompting, data, and batch systems

### 5.1 Text and AI-assist nodes

| Node/capability | Function |
|---|---|
| Prompt | Provides freeform text to model inputs. |
| Text | General text value node usable by models and data flows. |
| Prompt Concatenator | Combines an unlimited number of text inputs plus inline text. |
| Prompt Enhancer | Uses a selectable LLM and custom instructions to rewrite/enrich a prompt. |
| Run Any LLM | Sends text and optional images to a selectable LLM and returns text. |
| Image Describer | Converts image characteristics into editable text with selectable LLM/instructions. |
| Video Describer | Describes a video according to user instructions. |
| Prompt variables | Adds unlimited named inputs to a prompt; handles can show source, value, or both and be reordered. |

Sources: [Text tools](https://help.weavy.ai/en/articles/12268282-text-tools), [Prompt variables](https://help.weavy.ai/en/articles/14047674-prompt-variables).

### 5.2 Data types

- **Number** — configurable minimum, maximum, decimal precision, and exposed output.
- **Text** — reusable string input.
- **Toggle** — Boolean input.
- **List Selector** — manual values, array-driven values, or exposed model enum as a dropdown.
- **Seed** — explicit or random generation seed.
- **Array** — manual text items or text split into parts using a delimiter.

Source: [Datatypes](https://help.weavy.ai/en/articles/12268346-datatypes).

### 5.3 Iteration and batching

- **Text Iterator** accepts manually entered values, Array output, Prompt output, or CSV data.
- **Image Iterator** batches images.
- **Video Iterator** batches videos.
- A multi-result generation node can be converted directly into an image or video iterator.
- A CSV can be dropped onto the canvas to create a Text Iterator.
- Iterators let a downstream workflow repeat against each item, supporting prompt matrices, asset batches, aspect-ratio variants, character/outfit sets, and other scalable generation patterns.

Sources: [Iterators](https://help.weavy.ai/en/articles/12343281-iterators), [creating iterators from results](https://help.weavy.ai/en/articles/14688156-creating-iterators-from-existing-node), [Delights #3](https://help.weavy.ai/en/articles/15068263-new-figma-weave-delights-3).

## 6. Editing, masking, compositing, motion, and effects

### 6.1 Deterministic editing tools

The documented non-model editing toolbox includes:

- **Levels** for image or video tonal adjustment.
- **Crop** for image or video using presets or custom bounds.
- **Resize** including non-proportional stretch/squash.
- **Blur** with Box and Gaussian modes.
- **Invert**.
- **Channels** for RGBA manipulation.
- **Extract Video Frame** using a timeline, frame number, or timecode.
- **Painter** on an input image or blank canvas, with brush/eraser and both image and mask outputs.

Source: [Editing tools](https://help.weavy.ai/en/articles/12268186-editing-tools).

### 6.2 Mask and matte tools

- **Mask Extractor** with interactive add/subtract selection.
- **Mask by Text** for text-guided image masking.
- **Grow/Shrink** for matte expansion or contraction.
- **Merge Alpha**.
- **Video Matte** with selectable matte mode.
- **Video Mask by Text**.

These masks feed edit, composite, and generative operations for localized changes.

Source: [Matte tools](https://help.weavy.ai/en/articles/12414117-matte-tools).

### 6.3 Compositor

The Compositor is a layer-based image/video/audio construction surface inside a node:

- Each connected or inserted asset becomes a layer.
- Layers support ordering, position, scale, rotation, opacity, and blend modes.
- Layers can be multi-selected, duplicated, copied between Compositors, and grouped.
- A fill color can provide a background or the canvas can remain transparent.
- Native rectangle, ellipse, triangle, and star layers can be added.
- Native editable text layers can be added, pasted, transformed, and styled.
- Image, video, and sound can be inserted without separate upstream nodes.
- The Assets panel lists all image, video, and audio in the composition, including unused assets, supports source/type filtering, and shows layer usage counts.
- Audio/video layers can be trimmed, muted, and have volume adjusted.

Source: [Compositor](https://help.weavy.ai/en/articles/15887786-compositor-node).

### 6.4 Timeline

The timeline is enabled from the Compositor's edit mode. It supports:

- Project duration and frame-rate adjustment.
- Layer ordering.
- In/out trimming.
- Visibility, locking, and muting.
- Layer opacity, blend mode, position, scale, and alignment controls.

The public documentation establishes timeline-based sequencing and compositing; it does not establish a full keyframe/curve animation system comparable to a dedicated motion editor.

Source: [Timeline editor](https://help.weavy.ai/en/articles/14689260-timeline-editor).

### 6.5 Gen Effect

The live **Gen Effect** node creates a custom visual effect from natural-language instructions and an optional reference image. The generated effect:

- Applies to an image or video input.
- Produces controls tailored to the requested effect.
- Can generate requested sliders for later adjustment without regenerating the effect.
- Can be refined by editing the prompt/reference and regenerating.
- Can be saved to the workspace Saved library for reuse.

Source: [Gen Effect node](https://help.weavy.ai/en/articles/16118602-gen-effect-node).

## 7. Generative capability families

The model-level input and parameter surface varies, but the combined catalog exposes these task families:

### 7.1 Image

- Text-to-image.
- Reference-guided image generation and style transfer.
- Multi-image/reference composition.
- Character reference and consistency workflows.
- Image-to-image and remix.
- ControlNet, canny, depth, pose/sketch, and multi-angle generation.
- Inpainting, content-aware fill, and masked editing.
- Outpainting/reframing.
- Background removal and replacement.
- Relighting and lighting changes.
- Virtual try-on.
- Prompt enhancement and, on some Gemini edit nodes, web search.
- LoRA-driven generation and inpainting.
- Transparent background on supported models.
- Multiple aspect ratios, custom sizes, and output formats up to model-specific 4K options.
- Upscaling, sharpening, skin/detail enhancement, denoise, and grain/detail recovery.

Sources: [Image models](https://help.weavy.ai/en/articles/12284752-image-models-comparison), [Edit image models](https://help.weavy.ai/en/articles/12343904-edit-image-models-comparison), [Generate from image](https://help.weavy.ai/en/articles/12344174-generate-from-image-models-comparison), [Enhance images](https://help.weavy.ai/en/articles/12344205-enhance-images-models-comparison).

### 7.2 Video and motion media

- Text-to-video.
- Image-to-video.
- First-frame and first/last-frame generation.
- Multi-reference and element-guided video generation.
- Video-to-video restyling/editing.
- Prompted video changes to character, environment, camera, or objects.
- Motion transfer/control and pose/depth guidance.
- Character animation and performance transfer.
- Video reframe/outpaint.
- Keep source audio or generate audio on supported models.
- Multi-shot generation and camera concepts/fixed camera on supported models.
- Video upscale, smoothing/frame-rate output, and restoration.
- Timeline-based compositing of generated and imported layers.

Runway Aleph 2, released in Weave after the comparison tables were authored, adds reference images, frame/keyframe-directed edits, propagated changes across up to 30 seconds, and iterative preview/refinement.

Sources: [Video models](https://help.weavy.ai/en/articles/12344226-video-models-comparison), [Generate from video](https://help.weavy.ai/en/articles/12344285-generate-from-video-models-comparison), [Enhance video](https://help.weavy.ai/en/articles/12344342-enhance-video-models-comparison), [Runway Aleph 2 release](https://www.figma.com/blog/direct-every-frame-with-runway-aleph-2/).

### 7.3 Audio and speaking-character workflows

Established audio capabilities are:

- Import MP3, WAV, and OGG.
- Insert sound directly into a Compositor.
- Trim, mute, and adjust volume for sound/video layers.
- Feed audio into image- or video-driven lip-sync/avatar nodes.
- Generate or preserve audio in certain video generation/edit nodes.
- Some nodes expose sound-effect style controls.

The current public model documentation has no separate speech, music, or sound-generation comparison category. Product marketing describes Weave as working with audio, but this baseline does not infer a general-purpose TTS, music, or standalone SFX catalog beyond the documented capabilities above.

Sources: [Helpers overview](https://help.weavy.ai/en/articles/12268300-helpers-overview), [Compositor](https://help.weavy.ai/en/articles/15887786-compositor-node), [Lip sync models](https://help.weavy.ai/en/articles/12441548-lip-sync-models-comparison), [Video models](https://help.weavy.ai/en/articles/12344226-video-models-comparison).

### 7.4 3D

- Image-to-3D and, for some models, prompt-assisted 3D.
- Multi-view input using front/back/left/right images on supported models.
- Material/texture prompts and images.
- Topology/remesh, polygon type, target face count, texture size, simplification, quality, materials, and T-pose options depending on model.
- Interactive rotation/composition of generated 3D for still or video output.
- GLB is the only documented imported 3D format.

Source: [3D model comparison](https://help.weavy.ai/en/articles/12344357-3d-models-comparison), [five workflow examples](https://www.figma.com/blog/five-figma-weave-workflows/).

### 7.5 Vector

- Raster-to-vector conversion.
- Text-to-vector illustration.
- Recraft SVG-oriented generation.
- Vectorizer output includes SVG, EPS, PDF, DXF, and PNG; the two generation nodes are documented as PNG output despite their vector-oriented naming.

Source: [Vector models](https://help.weavy.ai/en/articles/12343888-vector-models-comparison).

## 8. Model catalog snapshot

This is a **documentation snapshot**, not a guaranteed live runtime registry. Most comparison pages were written in March or April 2026 and explicitly say the model list, parameters, and prices can change. Newer official releases are called out separately.

### 8.1 Image generation (25 documented entries)

ChatGPT Images 2.0; Reve; Higgsfield Image; GPT Image 1; Imagen 4; Imagen 3; Imagen 3 Fast; Flux 2 Pro; Flux 2 Flex; Flux 2 Dev LoRA; Flux 1.1 Ultra; Flux Pro 1.1; Flux Fast; Flux Dev LoRA; Recraft V3; Mystic; Ideogram V3; Ideogram V3 Character; Stable Diffusion 3.5; Minimax Image 01; Bria; DALL-E 3; Luma Photon; Nvidia Sana; Nvidia Consistory.

Source: [Image models comparison](https://help.weavy.ai/en/articles/12284752-image-models-comparison).

### 8.2 Image editing (35 documented entries)

ChatGPT Images 2.0 Edit; Gemini 3.1 Flash (Nano Banana 2); Gemini 3 Pro; Seedream V5 Edit; Seedream V4.5 Edit; Reve Edit; Qwen Image Edit 2511; Qwen Edit Image Plus; Flux 2 Inpaint Klein 9B; Runway Gen-4 Image; Seedream V4 Edit; Flux Kontext (the source currently says “Klux Kontext”); Flux Kontext Multi Image; Flux Kontext LoRA; GPT Image 1.5 Edit; GPT Image 1 Edit; SeedEdit 3.0; Gemini 2.0 Flash; Flux 2 Max; Flux Fill Pro; Flux Dev LoRA Inpaint; Ideogram V3 Inpaint; Ideogram V2 Inpaint; SD3 Inpaint; Bria Inpaint; Flux Pro Outpaint; SD3 Outpaint; SD3 Remove Background; Bria Remove Background; SD3 Content-Aware Fill; Kolors Virtual Try On; Replace Background; Bria Content Aware-Fill; Bria Replace Background; Relight 2.0.

Source: [Edit image models comparison](https://help.weavy.ai/en/articles/12343904-edit-image-models-comparison).

### 8.3 Generate from image (8 documented entries)

Flux Dev Redux; Flux ControlNet & LoRA; Flux Canny Pro; Flux Depth Pro; Qwen Edit Multiangle; Image to Image; Stable Diffusion ControlNets; Sketch To Image.

Source: [Generate from image models comparison](https://help.weavy.ai/en/articles/12344174-generate-from-image-models-comparison).

### 8.4 Image enhancement (9 documented entries)

Topaz Upscale; Topaz Sharpen; Recraft Crisp Upscale; Magnific Skin Enhancer; Magnific Upscale; Magnific Precision Upscale; Magnific Precision Upscale V2; Enhancor Image Upscale; Enhancor Realistic Skin.

Source: [Enhance images models comparison](https://help.weavy.ai/en/articles/12344205-enhance-images-models-comparison).

### 8.5 Video generation (34 entries in the April table)

Seedance 2.0; Seedance 2.0 Reference; Kling 3; Seedance V1.5 Pro; Wan 2.5; Grok Imagine Video; Sora 2; Wan 2.2; LTX 2 Video; Moonvalley; Veo 3.1 Text to Image (source label); Veo 3.1 Image to Video; Veo 3 Text to Image (source label); Veo 3 Image to Video; Veo 2; Seedance V1.0; Pixverse V4.5; Runway Gen-4.5; Runway Gen-4 Turbo; Runway Gen-4; Runway Gen-3; Kling 1.6; Kling Video; Kling O1 First & Last Frame; Kling 2.5 First & Last Frame; Kling 2.1 First & Last Frame; Luma Ray 2; Luma Ray 2 Flash; Minimax Video Director; Minimax Video 01; Hunyuan; Skyreels; Wan Video; Higgsfield Video.

Newer confirmed launch: **Seedance 2.5** is live for Starter and above by August 2026, but is not yet represented in the April comparison table.

Sources: [Video models comparison](https://help.weavy.ai/en/articles/12344226-video-models-comparison), [Seedance 2.5 launch](https://help.weavy.ai/en/articles/16211624-seedance-2-5-launch-promotion).

### 8.6 Generate/edit from video (16 documented entries plus a newer release)

Kling O1 Edit Video; Kling O1 Reference Video to Video; Kling O3 Edit Video; Kling Motion Control; LTX 2 Video to Video; Runway Aleph; Runway Act-Two; Luma Reframe; Luma Modify; Wan 2.2 Animate Replace; Wan 2.2 Animate Move; Wan Vace Depth; Wan Vace Pose; Wan Vace Reframe; Wan Vace Outpainting; Hunyuan Video to Video.

Newer confirmed release: **Runway Aleph 2**.

Sources: [Generate from video models comparison](https://help.weavy.ai/en/articles/12344285-generate-from-video-models-comparison), [Runway Aleph 2 release](https://www.figma.com/blog/direct-every-frame-with-runway-aleph-2/).

### 8.7 Video enhancement (4 documented entries)

Bria Video Upscale; Topaz Video Upscaler; Real-ESRGAN Video Upscaler; Video Smoother.

Source: [Enhance video models comparison](https://help.weavy.ai/en/articles/12344342-enhance-video-models-comparison).

### 8.8 Lip sync/avatar (4 documented entries)

Omnihuman V1.5; Sync 2 Pro; Pixverse Lipsync; Kling AI Avatar Pro.

Source: [Lip sync models comparison](https://help.weavy.ai/en/articles/12441548-lip-sync-models-comparison).

### 8.9 3D (9 documented entries)

SAM 3D Objects; Rodin; Rodin V2; Trellis 3D V2; Meshy V6; Hunyuan 3D V3; Hunyuan 3D; Hunyuan 3D V2.1; Trellis.

Source: [3D models comparison](https://help.weavy.ai/en/articles/12344357-3d-models-comparison).

### 8.10 Vector (3 documented entries)

Vectorizer; Recraft V3 SVG; Text To Vector.

Source: [Vector models comparison](https://help.weavy.ai/en/articles/12343888-vector-models-comparison).

### 8.11 Text-model catalog limitation

Text helpers let the user choose an LLM for prompt enhancement, freeform LLM execution, and image description, but the public help center does not provide an equivalent current comparison table naming every selectable LLM. A parity audit should therefore test the live toolbox rather than treating an inferred provider list as complete.

## 9. Extensibility and reusable systems

### 9.1 Import external models

Starter, Professional, Team, and Enterprise users can import model pages from Fal, Replicate, and CivitAI:

1. Add **Import Model** from the toolbox or `Tab` search, or paste a supported model URL directly onto the canvas.
2. Weave imports the model and maps its parameters into the right-side panel.
3. Configure and run the node.
4. Save it as a named model preset for use in other workflows.

The universal import surface materially expands the reachable model set beyond the curated catalog. It does not establish arbitrary local-code execution or a general plugin SDK.

Source: [Importing models](https://help.weavy.ai/en/articles/12265334-importing-models).

### 9.2 Import LoRAs

Users can upload a LoRA file, connect it to a compatible base model, expose a 0–1 strength control with a Number node, and connect multiple LoRAs where supported. Imported LoRAs are stored with the workflow.

Source: [Importing LoRAs](https://help.weavy.ai/en/articles/11046940-importing-loras-in-figma-weave).

### 9.3 Saved library

Saved items are shared across the active workspace:

- Model nodes can be saved with configured settings as named presets.
- Customized utility/edit nodes can be saved.
- Multi-node groups can be saved with a name, description, and representative thumbnail.
- Saved items can be dragged from the left panel or inserted from the canvas context menu.
- Names/descriptions can be edited and items deleted.

Source: [Using the Saved section](https://help.weavy.ai/en/articles/15495911-using-the-saved-section).

### 9.4 Turn a workflow into a tool

1. Connect the final result to an **Output** node.
2. Weave unlocks the **Tool** tab.
3. Nodes without upstream inputs become visible tool parameters.
4. Lock any source node whose parameter should remain hidden.
5. Click **Create tool**, name it, describe it, and add a thumbnail.
6. Share it with invitees, the workspace, or anyone with the link.
7. Edit the underlying workflow without changing the live tool.
8. Click **Update tool** when ready to publish the new version.

Each create/update saves a timestamped immutable tool version. Old versions can be viewed and shared but not edited.

Source: [Tools](https://help.weavy.ai/en/articles/12267755-tools).

## 10. Sharing, collaboration, history, and recovery

### 10.1 Workflow sharing model

View access can be limited to invited people, the active workspace, or anyone with the link. The documented editing patterns are:

- A viewer duplicates the workflow into their own workspace to edit independently.
- Ownership can be transferred; the file moves to the new owner's workspace and the old owner retains read-only access.
- Enterprise Workspace Files provide read-only visibility across members.

Current help documentation does **not** establish simultaneous multiplayer editing of the same standalone Weave workflow. “Collaborative” claims should therefore be interpreted as sharing, visibility, reuse, and handoff unless live product testing proves more.

Sources: [Sharing files](https://help.weavy.ai/en/articles/12944804-sharing-files), [File collaboration](https://help.weavy.ai/en/articles/13387857-file-collaboration).

### 10.2 Workflow version history

Weave automatically saves workflow versions. From the Weave menu, a user can open Version History, select a prior state, and either:

- **Restore** it over the current workflow, or
- **Duplicate** it into a separate file without disturbing the current state.

Source: [Version history](https://help.weavy.ai/en/articles/16110597-version-history).

### 10.3 Trash

Deleted workflows are archived in Trash for 30 days and can be restored during that period.

Source: [Workflow trash](https://help.weavy.ai/en/articles/14688405-workflow-trash).

## 11. Figma ecosystem integrations

### 11.1 Use a curated Weave tool in Figma Design

Eligibility: Professional, Organization, or Enterprise Figma plan plus `can edit` file access. During open beta, runs are free and do not consume Figma AI credits.

Flow:

1. Optionally select an image on the Figma Design canvas.
2. Open **Tools** from the navigation bar.
3. Filter resource type to **Weave**.
4. Browse and select a curated tool.
5. Configure the tool-specific inputs: selected/uploaded image, reference image, prompt, dropdown settings, and similar controls.
6. Choose the number of runs.
7. Click **Generate** and use the result in the design.

Documented examples include Generate mockup, Transfer style, Replace background, Change lighting, Text to vector illustration, and Apply color palette. The launch article also demonstrates on-brand icons and texturizing an input.

Source: [Use Weave tools in Figma](https://help.figma.com/hc/en-us/articles/40779260614935-Use-Weave-tools-in-Figma), [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/).

### 11.2 Inspect/remix a Figma tool in standalone Weave

1. Open Figma Design's **Tools** panel and filter to Weave.
2. Hover a tool.
3. Choose `…` → **Open in Weave**.
4. Sign into a separate Weave account; existing Figma credentials can be used.
5. Inspect the underlying node graph, duplicate it, and modify or extend it.

Runs in standalone Weave consume standalone Weave credits, not Figma AI credits.

Source: [Use Weave tools in Figma](https://help.figma.com/hc/en-us/articles/40779260614935-Use-Weave-tools-in-Figma).

### 11.3 Publish a workflow to Figma Community

1. Open the workflow in Weave.
2. Click **Share**.
3. Select **Publish to Community**.
4. Add a name, description, subcategory, and tags.
5. Choose a representative image.
6. Publish.

The workflow appears in Community search/feeds and the AI workflows section. Other users can discover and duplicate it. Example categories named by Figma include automated ads, multi-angle product shots, social motion systems, fashion visualizers, and character design sheets.

Source: [Publish to Figma Community](https://help.weavy.ai/en/articles/15624624-publish-weave-workflows-to-the-figma-community), [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/).

### 11.4 Run a Weave tool through an external agent via Figma MCP

Eligibility: Starter, Professional, Team, or Enterprise standalone Weave plan.

Setup and run flow:

1. In Weave, go to **Settings → Profile → Linked accounts** and connect the Figma account.
2. Make sure the intended Weave workspace is active; the agent only sees tools in that workspace.
3. Connect a supported agent client to the Figma MCP server; no separate Weave MCP server is needed.
4. Ask the agent to run a tool by name.
5. The agent lists tools, inspects the selected tool's required inputs, and requests missing values.
6. The agent can upload image, video, audio, or 3D input files.
7. If the run has a known nonzero credit cost, the agent reports it and asks for confirmation. Dynamic iterator costs may be unknowable in advance.
8. The agent starts the run, polls progress, can cancel it, and returns the output.

Agent execution consumes standalone Weave credits. The MCP surface cannot create or edit workflows.

Source: [Running Weave tools from external agents](https://help.weavy.ai/en/articles/16202764-running-weave-tools-from-external-agents-mcp).

### 11.5 Announced Figma node in Weave

Figma previewed a node that would:

- Accept a pasted Figma frame as a live node on the Weave canvas.
- Connect the frame to upstream and downstream workflow nodes.
- Reflect Figma frame edits in the Weave workflow in real time.
- Support workflows such as connecting a brand layout to translated CSV copy and producing localized outputs.

This remains **announced, not counted as live** in this baseline. The authoritative June 24 article called it upcoming and expected later in summer; no current help article confirming general availability was found on August 17.

Source: [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/).

## 12. Plans, credits, governance, and security

### 12.1 Standalone plan capability gates

| Plan | Monthly included credits | Workflow/model capabilities |
|---|---:|---|
| Free | 150 | Up to 5 workflows; no video models or imported models. |
| Starter | 1,500 | Unlimited workflows; all catalog models/tools; model import; top-ups; MCP tool execution. |
| Professional | 4,000 | Starter features; three-month credit rollover; custom fonts; larger top-up conversion. |
| Team | 4,500 per paid user into a shared pool | Professional-like capabilities; shared workflows/credits; per-member/default spend limits; usage exports. |
| Enterprise | Custom | Team features plus custom allocation, own API keys, training, expanded indemnity, premium support, and model governance/import approval. |

Plan prices and allocations are drift-prone. The live pricing page and in-product checkout should be treated as authoritative when the later parity audit evaluates commercial packaging.

Source: [Subscription plans](https://help.weavy.ai/en/articles/12267070-figma-weave-s-subscription-plans), [Managing credits](https://help.weavy.ai/en/articles/12541054-managing-credits).

### 12.2 Credit behavior

- Generative nodes consume credits; helper/edit nodes generally do not.
- Cost varies by model and settings such as resolution and seconds.
- Included credits renew monthly.
- Starter included credits reset; Professional and Team included credits can roll over for up to three months.
- Purchased top-up credits remain for one year and survive plan changes.
- Team credits are pooled; admins can cap each member's spend without reserving a separate balance.
- Admins can export member usage as CSV and download a time-bounded credit usage log.
- Figma AI credits and standalone Weave credits are separate.

Sources: [Credit system](https://help.weavy.ai/en/articles/12267166-figma-weave-s-credit-system), [Managing credits](https://help.weavy.ai/en/articles/12541054-managing-credits), [Figma Weave FAQ](https://help.weavy.ai/en/articles/12692387-figma-weave-faq).

### 12.3 Verified and unverified models

A **Verified by Figma** badge means Figma documents that:

- A contract exists with the provider.
- Customer content is used only to deliver the service.
- Content is not used for model training/improvement when accessed through Weave.
- The agreement includes contractual indemnity.

For unverified models, provider terms and privacy policies govern; Weave links those documents. “Unverified” is not itself a claim that the provider trains on customer data.

On Enterprise:

- Admins can approve/block catalog models through Model Management.
- Fal/Replicate import is disabled by default.
- Admins can enable imported-model requests.
- A user pastes a model URL, requests approval, and cannot run it until approved.
- Admins receive in-product and email notifications and approve/reject the request.
- The dashboard tracks status, requester, and the provider model URL.

Sources: [Verified and unverified models](https://help.weavy.ai/en/articles/14035518-verified-and-unverified-models), [Enterprise model management](https://help.weavy.ai/en/articles/12792774-enterprise-model-management), [Enterprise model import controls](https://help.weavy.ai/en/articles/15179921-enterprise-model-import-controls).

### 12.4 Security and cross-product data boundary

- Figma Weave states that it is SOC 2 Type II certified.
- Figma's FAQ says personal data and content used for AI features are not currently shared between Figma and standalone Weave.
- The products currently maintain separate plans, credits, and billing.

Sources: [About Figma Weave](https://weave.figma.com/about-us), [Figma Weave FAQ](https://help.figma.com/hc/en-us/articles/35965787376919-Figma-Weave-FAQ).

### 12.5 API boundary

- The help center says there is no public API integration for Weave.
- A run-only MCP integration now exists through Figma MCP.
- MCP does not create or edit workflows.
- Enterprise advertises “your own API keys,” which is a provider credential/commercial capability, not evidence of a public Weave execution API.

Sources: [API integration](https://help.weavy.ai/en/articles/12301695-api-integration), [external agents/MCP](https://help.weavy.ai/en/articles/16202764-running-weave-tools-from-external-agents-mcp), [subscription plans](https://help.weavy.ai/en/articles/12267070-figma-weave-s-subscription-plans).

## 13. End-to-end user-flow map

### Flow A — Start a standalone workflow from scratch

1. Sign in to Weave, optionally using Figma credentials.
2. Select the personal or team workspace.
3. Click **Create new file**.
4. Add prompt/media/data nodes through toolbox, `Tab`, paste, drag/drop, or shortcuts.
5. Add one or more generative or editing nodes.
6. Wire compatible typed inputs.
7. Configure model settings in the right panel and inspect cost.
8. Run a generative node.
9. Inspect generations, prompt/settings/seed, and choose the result to continue.
10. Branch to other models or edits, compare candidates, and refine.
11. Add Preview/Export or download selected/all results.

### Flow B — Build a reusable visual style system

1. Import two or more brand/reference images.
2. Describe each with Image Describer.
3. Edit and combine descriptions into a master style definition.
4. Route that definition to several image models.
5. Generate alternatives and compare outputs.
6. Save the successful prompt/model/group as workspace presets.
7. Reuse it with new subjects and downstream aspect-ratio branches.

### Flow C — Batch a workflow across data or assets

1. Create or import an Array, CSV, image collection, video collection, or multi-result node.
2. Create the appropriate Text/Image/Video Iterator.
3. Connect the iterator to a parameterized downstream graph.
4. Expose variable controls where useful.
5. Run the repeated workflow.
6. Unpack, compare, select, or bulk-download results.

### Flow D — Edit or transform an existing image

1. Import/select an image.
2. Create a full-image or text/paint/extracted mask if the edit is local.
3. Choose deterministic edit nodes or an image-edit model.
4. Supply prompt, references, style, or LoRA inputs as required.
5. Generate multiple results.
6. Compare against the original or another candidate.
7. Continue into enhancement, compositing, or export.

### Flow E — Generate and finish a video

1. Start from a prompt, first frame, first/last frames, image references, or source video.
2. Select a video generation/edit model and configure duration, aspect ratio, resolution, camera, audio, and reference options.
3. Generate and inspect the candidates.
4. Optionally use video-to-video, motion control, performance transfer, reframe, or enhancement nodes.
5. Add media to the Compositor.
6. Arrange image/video/audio layers, masks, text, shapes, transforms, blends, and background.
7. Enable the timeline; trim/reorder/mute layers and set duration/FPS.
8. Preview and export the production asset.

### Flow F — Create 3D from reference images

1. Import or generate object reference images.
2. For supported models, produce front/back/left/right views.
3. Feed the images to a 3D model node.
4. Configure materials, topology, polygon/face/texture settings as available.
5. Generate and rotate the model to choose the desired angle.
6. Use the result as a still or as input to a video/composite workflow.

### Flow G — Make a speaking character

1. Provide an image or video of the character according to the selected lip-sync node.
2. Provide an audio file, or text/voice input where the node supports it.
3. Configure optional prompt/voice controls.
4. Run the model and receive MP4 output.
5. Composite, trim, enhance, or export.

### Flow H — Import and standardize an external model

1. Copy a Fal, Replicate, or CivitAI model-page URL.
2. Paste it on the canvas or into Import Model.
3. Review the generated parameter surface.
4. Connect required typed inputs and run it.
5. Save the configured model to the workspace library.
6. On Enterprise, wait for admin approval when required.

### Flow I — Build and publish a reusable standalone tool

1. Finish and test a workflow.
2. Connect the desired end result to Output.
3. Open Tool mode.
4. Confirm which unconnected source nodes become public inputs.
5. Lock parameters that should stay internal.
6. Create the tool with name, description, and thumbnail.
7. Share with invitees, workspace, or link.
8. Update the underlying graph and explicitly publish a new tool version when ready.

### Flow J — Consume a shared standalone tool

1. Open the shared tool URL.
2. Fill the exposed prompts, media, values, and selectors.
3. Run the tool and inspect/download output.

### Flow K — Share or hand off an editable workflow

1. Choose specific invitees, workspace visibility, or link visibility.
2. Recipient opens the workflow in read-only mode.
3. Recipient duplicates it to edit independently, or the owner transfers ownership.
4. On transfer, the file moves to the recipient's workspace and the former owner becomes read-only.

### Flow L — Publish and consume a Community workflow

Publisher:

1. Share → Publish to Community.
2. Add metadata, tags/category, and image.
3. Publish publicly.

Consumer:

1. Discover the workflow in Figma Community search/feed/AI workflows.
2. Open it in Weave.
3. Duplicate it.
4. Inspect, run, adapt, and republish according to Community rules.

### Flow M — Run a curated Weave task inside Figma Design

1. Select a design image or begin from the Tools browser.
2. Tools → filter to Weave → choose a tool.
3. Provide the tool-specific inputs.
4. Choose run count and Generate.
5. Use the generated result in the Figma file.
6. Optionally open the underlying workflow in standalone Weave for deeper customization.

### Flow N — Delegate a tool run to an external agent

1. Link Figma and Weave accounts and select the intended Weave workspace.
2. Ask the connected agent to find a named Weave tool.
3. The agent inspects required inputs and requests anything missing.
4. Provide or let the agent upload supported media.
5. Confirm the quoted credit cost when required.
6. The agent runs, monitors, optionally cancels, and returns the result.

### Flow O — Govern models and spend as a team/admin

1. Invite/remove members and set the active team workspace.
2. Choose pooled spending or per-user/default limits.
3. Review/export member credit usage.
4. On Enterprise, approve/block model catalog entries.
5. Optionally enable imported-model requests.
6. Review provider terms/status and approve/reject each request.

### Flow P — Recover or branch previous work

1. Open workflow Version History.
2. Select an autosaved state.
3. Restore it or duplicate it as a new branch.
4. For deleted files, open Trash and restore within 30 days.
5. For a published tool, select and share an immutable earlier tool version.

## 14. Official showcase workflows

Figma's April 2026 walkthrough chains five workflows into a complete brand system:

1. **Combine two reference images into a style guide** — describe both images, merge and tune their stylistic influence, then test the style across models.
2. **Generate variants in multiple aspect ratios** — use an LLM to make a master style description, apply it to a new subject, generate alternatives, and create channel-specific ratios.
3. **Explore multiple distortion effects** — fan one asset into several effects, remove backgrounds, place results on brand colors, and compare.
4. **Convert an image into 3D** — generate multiple object views, create a rotatable Rodin 3D model, and lock a composition angle.
5. **Composite elements into video** — use motion references, a 3D element, video generation, and compositing; export the result back to Figma.

The same official material also presents workflows for user-persona scenes, character sheets, variable-driven outfits/characters, product/e-commerce photography, mockups, localized layouts, ads, fashion visualization, event graphics, presentation visuals, and manufacturing-oriented 3D references.

Sources: [Five scalable workflows](https://www.figma.com/blog/five-figma-weave-workflows/), [user persona template](https://www.figma.com/blog/steal-this-template-bring-a-user-persona-to-life-with-figma-weave/), [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/).

## 15. Explicit constraints and non-capabilities for later parity work

These boundaries prevent announced, adjacent, or implied functionality from being scored as current parity requirements:

- No current proof that the live Figma-frame node has shipped.
- No public Weave API; MCP is run-only and cannot author/edit graphs.
- No direct Google Drive or iCloud upload.
- Imported 3D is GLB-only.
- Free standalone accounts cannot use video or imported models and can create only five workflows.
- Figma Design's Weave tools require paid Figma plans and edit access, despite being free to run during beta.
- Figma Design currently exposes a curated tool collection; Community workflows are a separate discovery/duplication surface.
- Standalone Weave and core Figma have separate plans, billing, credits, and current data boundaries.
- Shared workflow editing is documented as duplicate-or-transfer, not simultaneous co-editing.
- Prior tool versions are viewable/shareable but not editable.
- Model capabilities, parameters, costs, formats, and limits vary per node.
- The public model comparison catalog lags product launches; live-toolbox verification is required before declaring a model gap.
- The public help center does not provide a complete named LLM catalog or a standalone audio-generation model family.
- Timeline compositing is documented, but a general keyframe/curve motion-authoring system is not established.
- External model import covers Fal, Replicate, and CivitAI URLs; it is not evidence of arbitrary plugins, local inference, or user-authored executable nodes.

## 16. Evidence quality and remaining live-verification questions

### High-confidence, current primary-source evidence

- Standalone editor mechanics and node categories.
- Dashboard, file sharing, version history, trash, and Saved library.
- Tool creation/versioning/sharing.
- Figma Design tool flow and beta gating.
- Community workflow publishing.
- External-agent/MCP run flow and limitations.
- Gen Effect, current Compositor behavior, Seedance 2.5, and Aleph 2 launches.
- Plan/credit/governance documentation.

### Requires authenticated live-product verification before a final parity score

1. Exact current toolbox/model inventory and node count.
2. Exact selectable LLM inventory.
3. Whether any standalone speech/music/SFX generators exist beyond the documented video/audio paths.
4. Whether the Figma node has begun limited rollout despite lacking a current help article.
5. Whether custom creator tools can now appear directly in Figma Design beyond the curated set.
6. Actual simultaneous-edit behavior in a shared standalone workflow.
7. Current model parameters, prices, maximum dimensions, duration, and output formats.
8. Browser/mobile behavior and performance ceilings for large graphs and media.
9. Enterprise identity controls such as SSO/SCIM and retention settings, which were not established by the capability sources reviewed here.

## 17. Primary source register

### Product, integration, and examples

- [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/)
- [Use Weave tools in Figma](https://help.figma.com/hc/en-us/articles/40779260614935-Use-Weave-tools-in-Figma)
- [Figma Weave FAQ](https://help.figma.com/hc/en-us/articles/35965787376919-Figma-Weave-FAQ)
- [Five scalable workflows](https://www.figma.com/blog/five-figma-weave-workflows/)
- [Runway Aleph 2 in Weave](https://www.figma.com/blog/direct-every-frame-with-runway-aleph-2/)
- [User persona template](https://www.figma.com/blog/steal-this-template-bring-a-user-persona-to-life-with-figma-weave/)

### Editor, media, and reuse

- [Weave editor collection](https://help.weavy.ai/en/collections/15341378-weave-s-editor)
- [Nodes and models collection](https://help.weavy.ai/en/collections/15247921-nodes-and-models-documentations)
- [Helpers overview](https://help.weavy.ai/en/articles/12268300-helpers-overview)
- [Editing tools](https://help.weavy.ai/en/articles/12268186-editing-tools)
- [Matte tools](https://help.weavy.ai/en/articles/12414117-matte-tools)
- [Compositor](https://help.weavy.ai/en/articles/15887786-compositor-node)
- [Timeline editor](https://help.weavy.ai/en/articles/14689260-timeline-editor)
- [Gen Effect](https://help.weavy.ai/en/articles/16118602-gen-effect-node)
- [Tools](https://help.weavy.ai/en/articles/12267755-tools)
- [Saved section](https://help.weavy.ai/en/articles/15495911-using-the-saved-section)
- [Version history](https://help.weavy.ai/en/articles/16110597-version-history)
- [External agents/MCP](https://help.weavy.ai/en/articles/16202764-running-weave-tools-from-external-agents-mcp)

### Extensibility, plans, and governance

- [Importing models](https://help.weavy.ai/en/articles/12265334-importing-models)
- [Importing LoRAs](https://help.weavy.ai/en/articles/11046940-importing-loras-in-figma-weave)
- [Subscription plans](https://help.weavy.ai/en/articles/12267070-figma-weave-s-subscription-plans)
- [Credit system](https://help.weavy.ai/en/articles/12267166-figma-weave-s-credit-system)
- [Verified and unverified models](https://help.weavy.ai/en/articles/14035518-verified-and-unverified-models)
- [Enterprise model management](https://help.weavy.ai/en/articles/12792774-enterprise-model-management)
- [Enterprise import controls](https://help.weavy.ai/en/articles/15179921-enterprise-model-import-controls)
- [About/SOC 2](https://weave.figma.com/about-us)
