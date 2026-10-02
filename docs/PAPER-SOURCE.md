# Paper Source

Use editable Paper artwork as an image input in Nebula. Each successful link or
changed refresh captures an immutable PNG; a run keeps the snapshot it used.

## Setup

1. Install and open [Paper Desktop](https://paper.design), sign in to your own
   account, and open the file containing your artwork.
2. Run the Nebula backend on the same computer. Paper Desktop installs its CLI
   when opened, as described in [Paper's MCP guide](https://paper.design/docs/mcp).
3. In Nebula's node library, add **Paper Source**.

Nebula connects directly to the local Paper CLI over MCP. You do not need to
paste a Paper API key into Nebula or configure an agent to use this node.
Signing in to the Paper website alone does not provide the local desktop
connection. Downstream generators still need their own provider credentials.

The default CLI path is `~/.paper/bin/paper`. If yours differs, copy its path
from Paper's MCP panel and set `NEBULA_PAPER_CLI` in the backend environment
before starting Nebula:

```bash
export NEBULA_PAPER_CLI="/absolute/path/to/paper"
```

Use the executable path alone; Nebula supplies the `mcp` argument.

## Link, edit, and rerun

1. Select one logo or asset in Paper Desktop.
2. In the Paper Source node, click **Link selected object**. Confirm the file,
   page, and object, choose the export scale, then click **Export and link**.
3. Connect the node's **Image** output to a downstream node and run your recipe.
4. Click **Open in Paper** to return to the editable original and make a change.
   **Open source link** provides a browser link to the same object.
5. Return to Nebula and click **Refresh source**. Changed artwork becomes a new
   snapshot and earlier results are marked **Out of date**.
6. Click **Rerun with latest source** on the result or in Run History. This uses
   the saved recipe's settings and connections with the new exported artwork.

**Refresh never triggers generation.** It only captures the source and updates
its status. An unchanged refresh keeps the current snapshot. Earlier snapshots,
outputs, and run records remain available; the normal history **Rerun** action
uses that run's original snapshot.

The export preserves the artwork's background. An object with transparent
pixels stays transparent; an opaque artboard is not automatically cut out.

## If the source is unavailable

- **CLI unavailable:** open Paper Desktop, check the CLI path, and use the
  environment override above if needed.
- **Disconnected or timed out:** confirm Paper Desktop is running with the file
  open, then try again. The last successful snapshot is retained.
- **Deleted object or moved to another page/file:** use **Reconnect object** to
  select the replacement, then confirm **Export and reconnect**. For
  **Reconnect by ID**, enter its file, page, and object IDs and click
  **Inspect exact object** before confirming. A successful reconnect keeps the
  canvas node and its connections; rerun the recipe explicitly afterward.
- **Desktop link does not open:** use **Open source link** to open the asset in
  your browser. Opening either link does not refresh or run anything.

[Watch the captioned demo](../videos/paper-linked-source/renders/paper-linked-source-demo.mp4)
or read the [implementation verification](paper-source-verification.md).
The captioned demo uses a deterministic local video fixture; the README image
comes from the later demo using saved provider-generated animations.
