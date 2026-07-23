# Remotion export

Nebula previews a `VideoGraphManifest` with `@remotion/player` and renders that
same manifest locally with `@remotion/renderer`. The render worker passes one
unchanged `{ manifest }` object to both `selectComposition()` and
`renderMedia()`, so duration calculation and rendered component props use the
same input as the editor Player.

## Runtime contract

- `POST /api/remotion-render` starts a 1280×720, 30 fps H.264 MP4 render.
- `GET /api/render-jobs/{id}` reports monotonically increasing progress and the
  final `/api/outputs/...` download URL.
- `DELETE /api/render-jobs/{id}` cancels the Remotion render and its child
  browser/ffmpeg work.
- Running a `remotion-node` on the canvas uses the same renderer and returns the
  MP4 through its `video` output.
- Rendering is local and makes no paid provider call. It can use substantial CPU.

All Remotion packages are pinned together at `4.0.479`. This is the first
release outside the renderer/bundler advisory ranges found during the export
implementation, was more than 14 days old when adopted, and leaves `npm audit`
at zero findings.

## License boundary

Checked 2026-07-23. Remotion currently offers a free license to individuals and
companies of up to three people, including commercial use. Collaborations and
companies with four or more people require a Company License. Nebula does not
automatically acquire or validate that license; the person or organization
using the renderer is responsible for meeting Remotion's terms.

Canonical references:

- [Remotion licensing and pricing](https://www.remotion.dev/)
- [`renderMedia()` API](https://www.remotion.dev/docs/renderer/render-media)
- [`bundle()` API](https://www.remotion.dev/docs/bundle)
- [`makeCancelSignal()` API](https://www.remotion.dev/docs/renderer/make-cancel-signal)
