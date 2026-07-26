# BEMMP Service Dashboard

Analytics over BEMMP (Biomedical Equipment Maintenance & Management Program) service
tickets for Cyrix Healthcare. Kerala and Andhra Pradesh contracts, with open-call,
penalty, FTFR and repeat-call analysis and drill-down at every level.

A static React app with no backend. Ticket data comes from one of two places:

- **Server build** — a Node script reads the `TM-*.xlsx` exports once and emits a compact
  columnar artifact the browser loads into typed arrays.
- **Upload build** — the user picks their own `TM-*.xlsx` and it is parsed *in the
  browser*, so no ticket data is ever published or transmitted.

Both paths share the same row pipeline (`shared/schema.mjs`) and produce byte-identical
output.

## Getting started

```bash
npm install
npm run build:data     # reads BEMMP DATA/*.xlsx -> public/data/
npm run dev            # http://localhost:5173
```

`build:data` needs the workbooks in `BEMMP DATA/`. Without them, run `npm run dev` and
load a workbook through the **Data** panel instead.

## Commands

| Command | What it does |
|---|---|
| `npm run build:data` | Rebuild every state's artifact. `npm run build:data kl` for one. |
| `npm run refresh` | `build:data` + `build` |
| `npm run dev` | Vite dev server |
| `npm run build` | Server build → `dist/` (37 MB, data included) |
| `npm run build:static` | Upload build → `dist/` (235 KB, no data) |
| `npm run serve` | Serve `dist/` on localhost and the LAN, with the Refresh API |
| `npm start` | `build` + `serve` |

## Deploying

See [DEPLOY.md](DEPLOY.md). Short version:

- **Office users** → `npm start` on one machine. One-click Refresh, nothing leaves the
  building.
- **A link you can send out** → `npm run build:static` to GitHub Pages. Ships no data;
  users upload their own export.

Do not publish the server build to a public host — the artifact contains engineer names
and phone numbers.

## Working on it

[CLAUDE.md](CLAUDE.md) documents the business rules that are easy to get wrong: the three
ticket buckets, the penalty SLA, FTFR, and the normalisations applied at build time. Read
it before changing anything in `shared/schema.mjs` or `src/data/`.
