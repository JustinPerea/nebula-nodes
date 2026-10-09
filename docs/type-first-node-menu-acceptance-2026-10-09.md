# Type-first node discovery — acceptance

The Nodes drawer now starts with Image, Video, Audio, Text, Import and 3D, plus Workflow and Tools. Search all models remains one action away, and typing from the entry menu searches the complete catalog. A type choice browses existing definitions; adding still requires an explicit named-node selection.

## Evidence

| Check | Result |
|---|---|
| Catalog reachability | All 255 frontend/backend definitions have an intentional browse group. Generation categories take precedence over incidental outputs; six Paper/file sources remain in Import. |
| Search and providers | Existing task/model/provider vocabulary and alternate provider routes remain available. Scoped search can broaden to all models without discarding its query/provider. |
| Keyboard recovery | Type selection focuses Back; Back/Escape restores its opener. Empty-state recovery focuses the persistent search input. First-click expansion handles missing stored category entries. |
| Small layouts | Live geometry checked at 640×480, 800×300, 390×720 and 390×300. Compact controls leave 81px of results at 800×300; an 80px result minimum and outer scrolling preserve access at 390×300. Native Tab reached the named result. |
| Scroll disclosure | Live keyboard traversal reached the bottom entry action at 640×480. The bottom fade was present while content remained below and cleared at the end. Nested scrollers measure their own overflow. |
| Graph safety | Browsing preserved the exact synthetic three-node/two-edge graph export and execution-state fields. Explicit Kling selection added one node and preserved all earlier nodes/edges; test-node cleanup restored the exact export. |
| No execution | Synthetic counters remained at zero for generation, provider checks and motion handoff throughout review. No real provider generation was performed. |
| Verification | 20 NodeLibrary cases and 76 taxonomy cases are included in 178 passing focused frontend tests. Lint/style guards and TypeScript/production build/budget pass. |

Private browser captures and fixtures stay outside Git. Desktop captures show the actual interface over synthetic logo artwork. Responsive geometry was verified through browser device metrics; the normal browser viewport was restored afterward.

## Flora check

The user's signed-in empty Flora canvas showed the Add Node menu with media types, search and secondary tools. Selecting Image immediately created a default unrun draft. Undo restored the empty canvas; no generation occurred. Nebula deliberately retains explicit node selection and its existing provider-readiness controls. The observed GPT Image 2.5 Flare capability already exists in Nebula's Krea definitions, so this inspection introduced no new catalog gap.

References: [Flora toolbar](https://docs.flora.ai/editor/toolbar), [model search and compatible mentions](https://flora.ai/updates/elements-mentions-more).

## Limits

This is discovery UI work. No provider handlers, authentication, backend graph operations, saved recipes, history or packaged Electron behavior changed. The browser's Undo keyboard check did not confirm removal of the backend-created test node; cleanup used its explicit Delete action instead. Undo behavior is not claimed as newly verified by this slice.
