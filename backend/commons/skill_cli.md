### The same from your shell

Your shell reaches Nebula, so each `commons_*` tool also has a `nebula commons` CLI twin:

- `nebula commons search "<what you need>" --brand <brand>`
- `nebula commons get <id>`
- `nebula commons fetch <id> [--brand <brand>] [--out <dir>]` downloads the image through the
  scoped API into your current turn workdir and prints the local path. Use that copy; the Commons
  blob directory is not a runner input directory.
- `nebula commons borrow <id> --attribute palette --value "#1f6feb" --used-in '{"kind":"nebula_output","ref":"/api/outputs/<run>/<file>"}' --why "<why this reference>"`
- `nebula commons comment <id> "<text>" [--membership <id>]`
- `nebula commons add <path-or-url> --collection <id> --why "<why>"`
- `nebula commons collections [--brand <brand>]`, `nebula commons status`,
  `nebula commons borrowings [--asset <id>]`, `nebula commons fidelity <borrowing id>`,
  `nebula commons concentration`
- `nebula commons propose <id> --edit '{"correction": {"field_path": "summary", "value": "..."}}' --note "<why>"`
  (repeat `--edit` for up to 8; `nebula proposal <proposal id> --wait` waits for the person)
