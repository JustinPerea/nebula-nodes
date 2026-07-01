# Nebula iPad — conversion planning

Planning documents for the native iPad app. The web repo (`frontend/` + `backend/`) remains the **reference implementation**; iPad is a contract-compliant port, not a fork.

| Document | Purpose |
|---|---|
| [NEBULA-IPAD-SPEC.md](./NEBULA-IPAD-SPEC.md) | Master spec — architecture, contracts, agent pipeline, Siri, Foundation Models agent |
| [component-registry.yaml](./component-registry.yaml) | Machine-readable work queue for the conversion agent pipeline |
| [NODE-CONTRACT-AUDIT.md](./NODE-CONTRACT-AUDIT.md) | Per-node contract layer inventory (139 nodes) — waves, gaps, handler mapping |
| [NODE-CONTRACT-AUDIT.csv](./NODE-CONTRACT-AUDIT.csv) | Same audit as CSV for spreadsheets / agent ingestion |

Regenerate the node audit:

```bash
node scripts/audit-ipad-node-contracts.mjs
```

**Status:** Draft (2026-06-30). No native iPad code yet.
