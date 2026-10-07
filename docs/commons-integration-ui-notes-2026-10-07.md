# Commons UI integration notes — 2026-10-07

- Add the Commons workspace to current main through a lazy import and one optional rail destination. The current single appearance, keyboard rail behavior, dock state, Create session continuity, Paper/Krea/Batch/Cinema lifecycle and brand showcase remain on their existing implementations.
- Capability discovery is a separate unauthenticated configuration request. Missing, malformed or unavailable capability responses keep Commons disabled; disabled UI makes no Commons status, store or authentication requests. Entering the workspace is explicitly guarded in the store and records the return view without changing graph history or panel state.
- Adapt file selection and export to browser helpers rather than importing old desktop bridge and dialog machinery. A browser export acknowledges only that a download was started, never that a filesystem save completed. Packaged Electron integration remains outside this slice.
- Retain the local readiness fixes: failed comment/folder submissions keep drafts, committed writes clear only their own submitted draft, polling cannot replace newer review proposals, and model requests remain behind explicit actions.

- Enabled native chat sends and approval continuations carry `commonsToken` from the human browser session plus the selected `brand`; child actor tokens never enter the renderer. Disabled sends preserve their existing envelope and do not resolve Commons auth. Missing session authority preserves the draft and displays entry instructions. Brand changes start a new opaque conversation; running/authorizing turns cannot change brand or agent.
- Daedalus remains available in normal disabled mode. Enabled Commons shows its option disabled and explains that private reference chats currently support Claude/Codex, matching the verified native runner boundary. No silent fallback to a broader filesystem authority.
- After two 401 responses, clear the browser's expired Commons token so ongoing polls do not repeatedly send rejected authority. A new dev fragment supersedes any cached session.

- Keep shared Settings/Chat mounted behind an inert, hidden overlay during Commons navigation so in-flight turns, conversation IDs and chat history survive the round trip. Human token resolution is asynchronous; submitted chat text/attachments clear only their own captured draft, and the busy ref updates immediately to prevent duplicate sends.

- Browser routes `#commons` and `#view=commons` only become active after capability opt-in. Clearing a Commons route restores the recorded workspace; Back removes only that route while preserving other fragment fields. An authentication fragment alone does not navigate or generate anything.

- Browser auth errors point to a fresh Commons dev link from the backend terminal; this slice does not promise an unmerged packaged-desktop sign-in implementation. Existing optional bridge token resolution remains compatible but is not a release claim.

## Validation

- Full frontend suite: **1,183 tests in 126 files passed** on the selective integration (16.03 seconds). This includes the preserved Paper/Krea/Batch/Cinema/UI baseline and added Commons capability, route, authority, native-agent restriction, expired browser session, download, draft and actual App/chat continuity coverage.
- `npm run lint`: passed, including inline-style and Slava CSS scope guards.
- `npm run build`: TypeScript/Vite and build budget passed; Commons remains a separate lazy chunk and the initial index remains within its existing budget. Browser QA and backend/native security acceptance are coordinated separately by the root agent; unit tests do not claim production activation or paid-provider generation.

- Browser QA found that the legacy local-human stamp exposed the original developer's first name in comments. Render that legacy actor as "You" without changing any stored actor ID, provenance, permissions or schema. Other named actors remain distinguishable. Auth instructions were reviewed again: current browser errors point to the terminal dev link and the notes explicitly exclude packaged Electron claims.
