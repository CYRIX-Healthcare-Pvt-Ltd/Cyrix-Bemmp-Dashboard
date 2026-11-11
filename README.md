# BEMMP Service Dashboard

Analytics over BEMMP (Biomedical Equipment Maintenance & Management Program) service
tickets for Cyrix Healthcare. Kerala and Andhra Pradesh contracts, with open-call,
penalty, FTFR and repeat-call analysis and drill-down at every level.

A static React app with no backend for ticket data, which comes from one of two places:

- **Server build** — a Node script reads the `TM-*.xlsx` exports once and emits a compact
  columnar artifact the browser loads into typed arrays.
- **Upload build** — the user picks their own `TM-*.xlsx` and it is parsed *in the
  browser*, so no ticket data is ever published or transmitted.

Both paths share the same row pipeline (`shared/schema.mjs`) and produce byte-identical
output.

Signed-in users also get the daily penalty meeting's **ticket tracker** (with
Kerala, Andhra and Uttar Pradesh trackers), account administration, and
**Cyra**, a plain-language assistant that answers questions about the figures
without the model ever seeing ticket data.

> Part of **Cyrix One**, the platform at [app.cyrix.in](https://app.cyrix.in).
> System-wide picture: [Cyrix One Platform — System Architecture](https://claude.ai/artifact/HNYWoBqCJ6Xh3XcREuKpTu)
> (ask Adrian for access). Every repository: [REPOSITORIES.md](https://github.com/CYRIX-Healthcare-Pvt-Ltd/cyrix-platform/blob/main/docs/REPOSITORIES.md).

## At a glance

| | |
|---|---|
| Served at | `app.cyrix.in/bemmp` (portal rewrite to `cyrix-bemmp-dashboard.vercel.app`); also on-prem Docker on port 4173 and an upload-only build on GitHub Pages |
| Stack | React 18, Vite, plain JS and hand-written CSS; Node scripts (`node:test`, `pg`); Vercel functions in `api/`; optional Cloudflare Worker in `serverless/` |
| Database | Shared Supabase project (the same one as KPI): sign-in, accounts, meeting notes, audit, shared datasets in Storage. **Ticket figures never go into Postgres**: they are a columnar file built from the TM exports |
| Sign-in | The portal's session on app.cyrix.in; optional shared-password gate (`BEMMP_PASSWORD`) on the self-hosted server |
| Hosting | Vercel project `cyrix-bemmp-dashboard`; Docker (`docker-compose.yml`); GitHub Pages (`.github/workflows/deploy.yml`, upload build) |
| Maintainers | Kevin |
| Status | Live |

## Run locally

```bash
npm install
npm run build:data     # reads BEMMP DATA/*.xlsx -> public/data/
npm run dev            # http://localhost:5173/bemmp/
```

`build:data` needs the workbooks in `BEMMP DATA/` (git-ignored). Without them,
run `npm run dev` and load a workbook through the **Data** panel instead.

### Commands

| Command | What it does |
|---|---|
| `npm run build:data` | Rebuild every state's artifact. `npm run build:data kl` for one. |
| `npm run refresh` | `build:data` + `build` |
| `npm run dev` | Vite dev server |
| `npm run build` | Server build → `dist/` (37 MB, data included) |
| `npm run build:static` | Upload build → `dist/` (235 KB, no data) |
| `npm run serve` | Serve `dist/` on localhost and the LAN, with the Refresh API |
| `npm start` | `build` + `serve` |

## Environment variables

`.env.local` for local runs, `.env` for Docker (both git-ignored), Vercel for
the hosted build. See `.env.example` and `.env.local.example`.

| Name | Where it is set | Secret? | What it is for |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local`, Vercel | no | The shared Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `.env.local`, Vercel | no (publishable key) | Browser access; row-level security does the protecting |
| `VITE_BASE` | build environment | no | Base path; defaults to `/bemmp/`, the Pages workflow overrides it |
| `VITE_ASSISTANT_URL`, `VITE_ADMIN_URL` | build environment | no | Where the assistant and accounts API live, for static builds |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Vercel, `.env` | **yes** (service key) | `api/` functions and scripts; bypasses row-level security, never `VITE_` |
| `SUPABASE_PROJECT_REF`, `SUPABASE_DB_HOST`, `SUPABASE_DB_PASSWORD` | `.env.local` only | **yes** (password) | `scripts/db.mjs`, which runs a `.sql` file against the database |
| `OPENAI_API_KEY` | `.env` / `.env.local` (self-hosted); `app_secret` table (Vercel) | **yes** | Cyra and voice. On Vercel it is read from `app_secret`, set with `scripts/set-secret.mjs` |
| `OPENAI_MODEL`, `OPENAI_TTS_MODEL` | same | no | Optional model overrides |
| `BEMMP_PASSWORD`, `BEMMP_USER` | `.env` (self-hosted) | **yes** (password) | Optional shared-password gate over the whole server, including `/api/*` |

## Database

Sign-in, accounts and the meeting live in the shared Supabase project. The
ticket figures do not: they are `public/data/<state>/tickets.bin` and
`meta.json`, built by `npm run build:data` or in the browser from an upload,
and shared through Supabase Storage.

- `supabase/migrations/0001`–`0009` were written for BEMMP's own project,
  now retired, and replayed onto the shared project by
  [Cyrix-KPI 0060–0062](https://github.com/CYRIX-Healthcare-Pvt-Ltd/Cyrix-KPI/tree/main/supabase/migrations)
  (`is_admin` renamed `bemmp_is_admin` there).
- `0010` (Uttar Pradesh tracker) and `0011` (Cyra per person) came after the
  move and are applied to the shared project from here, by hand:
  `node scripts/db.mjs supabase/migrations/<file>.sql`. Check which project
  `.env.local` points at before you run one.

## Deploy

See [DEPLOY.md](DEPLOY.md). Short version:

- **Office users** → `npm start` on one machine. One-click Refresh, nothing leaves the
  building.
- **A link you can send out** → `npm run build:static` to GitHub Pages. Ships no data;
  users upload their own export.

Do not publish the server build to a public host — the artifact contains engineer names
and phone numbers.

- **app.cyrix.in/bemmp** → Vercel builds `main` on every push. `vercel.json`
  rewrites `/bemmp/api/*` to the `api/` functions and serves the SPA under
  `/bemmp/`.

Full instructions, including Docker on the office server, the tunnel, the
password gate and refreshing the data: [DEPLOY.md](DEPLOY.md).

## Checks before merging

```bash
npm test           # node:test, ~250 ms, synthetic fixtures, no workbooks needed
npm run build      # Vite build
npm run build:data # if the pipeline changed: must reproduce every figure in BASELINE.md
```

`BASELINE.md` (git-ignored) holds the real per-state totals; ask Kevin for it.

## How it works

[CLAUDE.md](CLAUDE.md) documents the business rules that are easy to get
wrong: the three ticket buckets (open, parked shown as "Unresolved calls",
resolved), penalty calls and penalty money, FTFR's Sunday rule and settled
cutoff, the normalisations applied at build time, the assistant's data
boundary, accounts and audit. Read it before changing anything in
`shared/schema.mjs` or `src/data/`.

## Related docs

- [CLAUDE.md](CLAUDE.md): business rules, architecture, and why each one is as it is
- [DEPLOY.md](DEPLOY.md): every way to publish it, and the data-sensitivity warning
- [cyrix-platform README](https://github.com/CYRIX-Healthcare-Pvt-Ltd/cyrix-platform#readme): the portal and how a module is added
