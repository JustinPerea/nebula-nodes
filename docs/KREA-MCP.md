# Connect a Krea account

Open **Settings → Connections → Krea MCP → Connect to Krea**. Nebula opens
Krea sign-in in your browser. If it does not open, click **Open Krea sign-in**;
use **Restart sign-in** if you need a fresh attempt. Sign in and choose a
workspace on Krea's consent screen. Return
to Nebula; the connection card updates when consent finishes. **Check connection**
initializes MCP and lists tools. Connecting or checking never generates media.

Choose the default connection for new Krea models, then save Settings:

- **Krea account · workspace compute** uses the signed-in MCP connection and the
  workspace selected during consent.
- **API token · API balance** uses the existing Krea API token from Settings.

Each Canvas/Create recipe saves its connection choice. Changing the default
does not change existing nodes, saved recipes or earlier runs. Nodes saved
before this feature keep using the API token. Change a node's **Krea connection**
control explicitly to switch it. Every Krea node that calls Krea offers the
choice: the whole gateway catalog (image, video, audio, enhance, 3D), Krea 2
Generate, Style Search, Style Train and Library Manage. Krea Moodboards and
Krea Moodboard Create are account-only because Krea's API has no moodboard
endpoints. Where one path cannot honor a saved control (for example the
account path has no style learning rate, and an API token cannot delete a
moodboard), the run stops before any request and says which connection to use.
The value-only helpers (Krea Style, Krea Moodboard, Image Style Reference)
never call Krea and have no connection choice.

Run a node or Create recipe explicitly to generate. Nebula discovers Krea's
tool and model schemas, uploads connected local media, submits once, polls the
job, and saves the actual results in the normal run directory. Stop requests
provider cancellation when a job ID is known. A lost connection does not
automatically resubmit a paid job. Earlier media and history remain available.

To change workspace, disconnect and reconnect, then choose the workspace again
on Krea's consent screen. Expired credentials refresh when possible; rejected
credentials require a new sign-in. OAuth credentials are local to this Nebula
installation, so other people cloning the repo connect their own accounts.

Nebula's Claude and Codex agents receive a local MCP bridge for read-only
discovery: models (`list_models`, `get_model_schema`), Krea's prompting guide,
the account's styles and moodboards, and node apps and node types. Krea Files
listings stay off the bridge because they include private and workspace-shared
file names. Nothing on the bridge generates, uploads, writes, deletes or spends.
Media requests continue through the canvas graph; the bridge cannot bypass run
history by directly calling `generate`. Hermes uses
a temporary managed MCP overlay when no administrator-managed overlay is
already present. Existing managed policy is preserved and takes precedence.
An already-running/resumed agent may need a new turn to see the connection.

Tokens never appear in settings, graph exports or agent configuration. Desktop
encrypts the vault using a key protected by the operating system's credential
storage; browser/dev mode uses an encrypted vault and an owner-only local key
under `NEBULA_STATE_DIR` (default `~/.nebula`). The OAuth callback is a temporary
loopback listener on the backend computer; use this setup locally. Each clone
should use a separate state directory when running concurrent backends.

The connector uses Krea's hosted Streamable HTTP server at
`https://api.krea.ai/mcp`. [Krea's current MCP documentation](https://www.krea.ai/docs/developers/mcp)
describes OAuth consent, workspace billing and supported tools. Krea's optional
MCP Apps result widget is not embedded in Nebula; results use its own canvas
previews and run history.

Development verification covers OAuth registration/callback/refresh, MCP tool
discovery, upload/generation/poll/cancel fixtures, and real local media
materialization. Public OAuth discovery is checked against Krea. An account's
consent, available compute and funded generation require that account's own
live connection; fixture checks do not establish those facts.
