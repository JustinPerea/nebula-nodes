# Camera and reference guidance in Cinema

Camera Rig and Reference Set connect to the matching inputs on a Cinema Scene node. Cinema uses them when you explicitly run the scene or a shot.

1. Add **Camera Rig**, **Reference Set** and **Cinema Scene** to the canvas.
2. Connect image nodes to Reference Set's labeled roles, such as Style, Lighting or Composition.
3. Connect Camera Rig's output to Cinema's **Camera Rig** input, and Reference Set's output to **Reference Set**.
4. Open Cinema Studio, select a supported base and run a shot. Camera values enter the prompt as camera guidance. Reference images are sent to the selected model, with a prompt legend identifying their roles by image number.

Reference **priority** determines stable ordering within the set; **0 excludes** an image. It is not a numeric model-adherence weight. Existing Character and shot references come first. Duplicate image URLs are sent once when the Reference Set contains active images, and their role labels share the same image number.

Editing a source, changing priority or disconnecting a wire does not start generation. Existing shot results, variations and earlier run artifacts stay available. Run again explicitly to use the edited graph; rerunning a saved recipe uses that recipe's original input snapshot.

## Supported reference adapters

| Cinema base | Reference limit |
| --- | --- |
| Seedream 4.5 or 5.0 Lite | 10; selects its edit endpoint when references are present |
| Google Nano Banana 2, Flash Lite or Pro | 14 |
| FAL Nano Banana 2 or Pro | 14 |
| Original Google/FAL Nano Banana | 3, a conservative adapter limit based on Google's best-performance guidance |
| Flux Kontext or Kontext Max | 1; its registered adapter accepts a single image |

Cinema checks the combined Character, shot and Reference Set image list before submitting each shot. Overflow produces a clear error; images are never silently truncated. Unsupported model selectors also fail before submission.

Camera Rig provides prompt guidance, so the generated composition depends on the model's interpretation. Current reference adapters have no native identity-strength control. Character consistency/override and Identity Edit strength remain saved for compatibility, but their controls are unavailable. Identity Edit also retains its legacy Mask port for saved connections and rejects a connected mask before submission because its current endpoint has no mask input. Seedream 5.0 Lite does not support a seed; saved seed values are preserved but omitted from its request.

Cinema translates Seedream's aspect ratio into its actual `image_size` field. A valid explicit `scene.base.params.image_size` in a saved recipe takes precedence.

Put prompts and references in Cinema's scene/shot fields and connected inputs. Saved `scene.base.params.prompt`, `image_url` or `image_urls` fields produce an error before submission because they would overwrite Cinema's validated inputs; the saved recipe remains intact.

Current schema sources and request-level evidence are listed in [the capability notes](cinema-art-direction-capability-notes-2026-10-07.md). Tests verify translation and history preservation using mocked provider responses and local PNG artifacts; they do not establish generated-image adherence.
