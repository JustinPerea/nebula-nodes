# Paper desktop link port to GitHub main

- Main predates the unrelated native file/dialog feature family. This port adds only `paperLinks.open`, its frozen preload method, and the Paper artwork IPC handler; it does not import the unpublished file-operations or dialog modules.
- The canonical desktop and HTTPS object routes are the same routes already verified against the installed Paper app. The OS launch handler restricts both routes to three bounded stable IDs and rejects arbitrary protocols, hosts, actions, traversal, credentials, encoded paths, queries, fragments, and control characters.
- The new shell boundary checks the actual current renderer contents and main frame as well as its configured origin (development) or exact packaged entry file. It avoids the existing credential handler's broad prefix check without changing the credential feature.
- Browsers retain anchor navigation inside the click gesture. Electron prevents app-window navigation and calls the narrow IPC method. Older Electron shells show the existing fallback error because they lack this new namespace.
- The Paper saved-recipe guard uses main's existing `window.alert` convention, avoiding an unrelated dialog-helper import.
- Verification uses mocked OS launches and a VM-executed real preload. No automated attempt is made to launch the Paper protocol; the human previously confirmed the desktop link works.
- Focused verification passed: 47 native Paper-link tests, 39 frontend Paper lifecycle/history/helper tests, TypeScript, focused ESLint, desktop main syntax, and whitespace checks. The initial TypeScript attempt found only the obsolete `desktopMode.ts` conflict file; after its scoped removal the compile passed.
