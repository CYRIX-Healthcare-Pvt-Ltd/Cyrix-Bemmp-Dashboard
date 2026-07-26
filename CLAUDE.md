# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A dashboard over BEMMP (Biomedical Equipment Maintenance & Management Program) service
ticket data. Cyrix Healthcare services biomedical equipment for state health departments;
this repo turns the raw ticket exports in `BEMMP DATA/` into an analytics dashboard.

Architecture is a **static React SPA with an offline preprocessing step** — no backend.
A Node script reads each workbook once and emits a compact columnar artifact the browser
loads into typed arrays; all filtering, aggregation and drill-down happen client-side.

## Commands

```
npm install
npm run build:data          # rebuild every state
npm run build:data kl       # rebuild one state
npm run refresh             # build:data + build
npm run dev                 # Vite dev server
npm run build               # production build -> dist/
npm run serve               # serve on localhost + LAN (port 4173)
npm start                   # build + serve
```

There are two shapes of deployment. `npm run build` produces the **server build** (37 MB,
artifacts included, Refresh button live). `npm run build:static` produces the **upload
build** — the same app with `dist/data` stripped, 235 KB, where each user supplies their
own `TM-*.xlsx` through the Data panel. The second one is what makes a public host safe,
because it ships no ticket data at all.

The browser parser in `src/data/workbook.js` and the Node script in
`scripts/build-data.mjs` share their whole row pipeline via `shared/schema.mjs`, so both
produce **byte-identical** `tickets.bin` and dictionaries. That equivalence is the thing to
protect when changing either one — a regression test that parses both workbooks and
compares against `public/data/*` catches it immediately.

Publishing routes and the data-sensitivity warning are in `DEPLOY.md`. Setting
`BEMMP_PASSWORD` turns on a shared-password gate over the whole server, including
`/api/*`; it is off by default because the LAN case does not need it.

`scripts/serve.mjs` is not just a file server. It serves the app shell from `dist/` but
`/data/` from `public/data/` — the live artifact — so a rebuild takes effect without
re-running `vite build`. It also exposes `/api/status` and `/api/refresh`, which back the
in-app Refresh button by spawning `build-data.mjs` and reporting source-vs-artifact
freshness. `build-data.mjs` therefore only runs `main()` when invoked directly; `serve.mjs`
imports `STATES` from it.

Caching rules there are load-bearing: only `/assets/` may be cached hard (Vite
content-hashes it). `index.html` and `/data/` must revalidate — a cached `index.html`
pins browsers to a build whose hashed assets no longer exist, recoverable only by a hard
reload on every client.

`build:data` must be run at least once before `dev` — the app fetches its artifacts from
`public/data/` and there is nothing to show without them. It prints per-state KPI totals,
which are the fastest sanity check that a data refresh worked.

## States

Every state's export has a **different schema** — do not assume a column exists in one
because it exists in another. A state is described entirely by its entry in the `STATES`
array in `scripts/build-data.mjs` (source file, column letters, penalty SLA, barcode
width); the rest of the pipeline is shared. Adding a state means adding a config, not
adding code.

| | Kerala (`kl`) | Andhra Pradesh (`ap`) |
|---|---|---|
| Source | `TM-KL.xlsx` | `TM-AP.xlsx` |
| Scale | a few hundred thousand rows | roughly half that |
| Penalty SLA | one window for all equipment | shorter window for critical |
| Barcode width | 7 | 8 |

> This repository is public, so real contract figures live in `BASELINE.md`, which is
> gitignored. That file carries the per-state totals, the Kerala cross-checks and the
> real sample values, and it is the regression baseline — after any pipeline change,
> `npm run build:data` must reproduce every number in it exactly. The SLA windows
> themselves are in the `STATES` array in `scripts/build-data.mjs`.

Column letters differ between the two, which is the main reason the config is per state:

| Field | KL | AP |
|---|---|---|
| Logged date / Resolved Date | `P` / `Q` | `N` / `P` |
| Ticket Remark | `X` | `X` |
| Equipment Type | `L` | `AA` |
| Asset Description | `K` | `J` |
| Down days | `AI` | `AB` (plus `AC` penalty days, `AD` penalty amount) |
| Zone, New Status Column | `D`, `AG` | absent |

Both worksheets run to hundreds of megabytes of XML uncompressed, so neither can be
opened with a load-the-whole-workbook parser. `build-data.mjs` streams them — unzip and
read the worksheet incrementally against `xl/sharedStrings.xml`. Follow the same approach
for any new one-off analysis.

## Ticket state — the three buckets

The single most important business rule in the project, and easy to get wrong. A ticket is
**open only when Resolved Date is blank AND Ticket Remark is blank**:

| Bucket | Rule |
|---|---|
| **Open** | Resolved Date blank AND Ticket Remark blank |
| **Parked** | Resolved Date blank AND Ticket Remark set |
| **Resolved** | Resolved Date set |

The middle bucket is **called "parked" everywhere in the code** — column names, the
pipeline, this document — but is **labelled "Unresolved calls" in the UI**, which is the
business's own wording. Only `BUCKET_LABEL` and a handful of user-facing strings carry the
display name; do not rename the internal identifiers to match.

Resolved Date blank *alone* overstates open by roughly **ten times** in Kerala. Parked
tickets are unresolved but outside the service scope, and Ticket Remark holds the reason —
`rber`, `warranty`, `physical damage`, `not under scope`, `power fluctuation`,
`rodent damage`. Report parked separately; never fold it into open.

**Blankness must be tested before parsing.** Kerala writes a literal `" "` string into an
unresolved Resolved Date (never a missing cell); Andhra leaves the cell absent. Both
coerce to `0`/epoch if parsed as a date.

Cross-checks that must hold for Kerala after any pipeline change — exact counts are in
`BASELINE.md`:

- The open rows are exactly those where `AG New Status Column = 'Pending'` and Ticket
  Remark is blank. Not every `Pending` row qualifies; a substantial minority carry a remark.
- In column `V`, `resolved` is **not** open. It rolls up with `closed` into
  `AG = 'COMPLETED'`, and the two must sum to the resolved total.

## Penalty calls

A **penalty call is an open call past its SLA window**, evaluated as of the newest logged
date in the export (`meta.dateRange.maxDay`). The window depends on equipment criticality
and comes from the state config.

```
age = referenceDay - loggedDay
penalty  <=>  bucket is OPEN  AND  age > window
```

The test is **strictly greater** because the logged date itself is not counted: a call
logged 1 July is on penalty on 9 July (age 8), not 8 July (age 7). Penalty is a subset of
open — parked and resolved calls never count, so a resolved call that took three weeks is
*not* a penalty call under this definition.

Andhra's export also carries its own `Penalty Down Days` and `Penalty Amount` columns; they
are preserved in the artifact but the dashboard computes the flag from the rule above so
both states are measured identically.

## Penalty money

Kerala's rate card comes from `KL Penalty Logic.xlsx` and is encoded in the state config
as `penaltyRates`. The workbook is written against `TODAY()` and the first of the current
month; the dashboard substitutes the **selected date range**, so the same arithmetic
answers "what did June cost" as well as "what is accruing now".

| Workbook | Meaning | Here |
|---|---|---|
| `AL` | exemption: RBER date, any Ticket Remark, or a standby request | `penaltyExempt`, set at build time |
| `AM` | penalty start = `Logged + 8` | `penaltyStartDay()` = logged + grace + 1 |
| `AN` / `AO` | window clamped to the reporting period | `max(start, from)` / `min(resolved, to)` |
| `AS` | penalty days = `AO - AN + 1`, floored at 0 | `penaltyDaysIn()` |
| `AT` | accrued = days x rate | `penaltyAmountIn()` |
| `AU` | per-day rate, by Asset Value band | `dayRate` column |
| `AZ` | closure penalty = `(Resolved - (Logged+8) + 1) x AU` | `closurePenalty()` |

Two things to keep in mind:

- **Closure penalty is scoped by Resolved Date**, not Logged Date — a ticket logged in
  April and closed in June belongs to June. It is the only view in the dashboard that
  filters on a different date field; `filterRows` takes a `dateField` option for it.
- **Accrual ignores the logged-date window entirely** (`dateField: null`). A call logged
  in May is still running up penalty in July, which is exactly what `AN`'s clamp encodes.
  Filtering accrual by logged date silently understates it.

`closurePenalty()` clamps at zero. The workbook does not, so a ticket closed inside its
grace window produces a negative figure there; those tickets owe nothing.

Andhra has **no rate card** — `penaltyRates` is null and the money tab says so rather than
inventing figures. Its export carries its own `Penalty Down Days` and `Penalty Amount`,
preserved as `srcPenaltyDays`/`srcPenaltyAmount`.

## FTFR (First Time Fix Rate)

A call logged today and resolved today or tomorrow is a first-time fix:
`resolvedDay - loggedDay <= 1`. The window is `FTFR_MAX_DAYS`, declared in both
`scripts/build-data.mjs` and `src/data/query.js` — change both together.

The denominator is **resolved calls only**, not all calls: an open call has no fix to rate.
No row in either state resolves before it was logged, so the duration never needs clamping.

## Normalisation applied at build time

All of it changes grouping only — every headline total is identical with and without it.

**Barcode** — stored inconsistently: some cells are shared strings that keep the leading
zero (`"0123456"`), others are numeric cells where Excel dropped it. Zero-padded to the
state's width before grouping, or the same asset counts as two.

**Case folding** — `Dialysis Machine` and `Dialysis machine` are one equipment type stored
two ways, which splits the counts the dashboard exists to report — at one large facility
the two spellings each held roughly half the true total. `facilityName`, `model`, `department`, `deviceGroup`, `equipment` and
`manufacturer` are interned case-insensitively, displaying whichever spelling is most
common. Deliberately case-only — spellings differing by more than capitalisation stay
separate — a misspelled manufacturer and its correctly spelled legal name remain two
entries, as do `Sterlizer` and `Sterilizer`. Merging those needs a curated alias table,
not a normalisation rule. See `BASELINE.md` for the real examples.

**Equipment type** — Kerala writes `CRITICAL`/`NON CRITICAL`, Andhra `Critical`/
`Non-Critical`. Both collapse to one vocabulary because the penalty rule keys off it.

**District** — `KASARGODE` is the only shouted value in Kerala; title-cased to match.

**Ticket id** — a bare number in Kerala, `AP` plus a number in Andhra, with a few bare
numbers mixed into the Andhra export too.
The alpha prefix is split from the number and stored as a tiny dictionary plus an Int32,
which keeps the id exact without a 265k-entry string dictionary. Reassemble with
`ticketLabel()` in `src/data/store.js`; never render `ticketNo` on its own.

## Generated artifact

`build:data` writes **build output, not source** — regenerate rather than hand-edit:

- `public/data/states.json` — the states that have been built, for the switcher.
- `public/data/<id>/meta.json` — dictionaries, column order, row count, date range,
  penalty SLA, and precomputed headline KPIs.
- `public/data/<id>/tickets.bin` — concatenated `Int32Array` columns in `meta.columns`
  order. The browser slices it into typed arrays with zero parse cost.

Columns are a shared union across states; fields a state does not supply stay at the
`-1`/`0` sentinel so the reader never branches per state. Adding a column means updating
both the writer in `scripts/build-data.mjs` and the reader in `src/data/`.

Two source columns are deliberately excluded. Kerala's `AH Last Remark` is very nearly one
unique string per row (~14 MB of dictionary) because it embeds names and timestamps;
`Customer mobile` is personal data the dashboard has no use for. The engineer column (`W Assigned`)
is only ~300 unique values per state and is included — `parseEngineer` splits its two
shapes, `CODE - Engineer Name - phone` and `ABC - District - DI USER ID - phone`.

## UI conventions

**Drill-down** is one component, `DrillExplorer`, used by the open, penalty and repeat
tabs. It takes a row set and a mode (`tickets` or `repeats`), and every breakdown bar
pushes onto a drill path. The dimension order is district → facility → equipment →
manufacturer → engineer → department → facility type, matching how a service manager
narrows down. In `repeats` mode the repeat analysis re-runs at each level, so "repeat"
keeps meaning ">1 call on the same asset" inside whatever has been drilled into rather
than filtering a precomputed all-time list.

**Aggregation must stay one linear pass per breakdown.** It runs on every filter and drill
change. Anything shaped like "for each asset, scan the rows" is O(assets x rows) — 11
billion operations at Kerala's full scope — and will hang the tab. Add new breakdowns to
the single pass, the way `analyzeRepeats` collects its rows.

**Colour**: chart series come from the validated data-viz palette and are stepped per
theme; brand red and navy are chrome only (logo, accents, state switcher) and never encode
data. The theme toggle writes `data-theme` on the root, and that scope is authored to beat
the `prefers-color-scheme` block in both directions.

**Date range**: the dashboard opens on the **current month of the data**, not all time and
not the calendar month — the export lags reality, so "this month" is derived from
`meta.dateRange.maxDay`. Every preset is anchored to `maxDay` for the same reason.

**Charts**: one component, `MetricChart`, with the metric passed in. All four series
(volume, FTFR %, repeats, penalty) come from a single `buildSeries` pass so switching tabs
costs nothing and the periods always line up. Granularity follows the selected date range
until the user picks one. Values are labelled selectively — peak, trough and latest — never
one per point.

**Motion**: decorative animation lives in `Backdrop.jsx` and is gated on `data-motion` on
the root, seeded from the OS but overridable via `MotionToggle`. Windows' "Animation
effects" setting makes Chrome report `prefers-reduced-motion: reduce`, which silently
killed the whole ambient layer with no way to switch it back on — hence the explicit
toggle. Reduced now means *static*, not hidden: the orbs, grid and ECG still render, they
just stop moving. Automated browsers report `reduce`, so screenshots show the static form
unless `data-motion="full"` is stamped manually.

**Mobile**: the filter bar collapses behind a toggle below 860px (the `[hidden]` attribute
needs the `!important` reset in `styles.css` — a class rule like `.filters { display: flex }`
beats UA specificity otherwise). The KPI grid steps 4 → 3 → 2 columns so eight tiles never
leave a short final row.

## Dirty values to expect

- `Contract Status` has both `WARRANTY` and `Warranty`.
- `Model` / `Manufacturer` / `Serial No` use `NA`, `na`, `NIL`, `Nil`, `nil`, `0000` and
  blanks interchangeably for "unknown".
- `Device Group` is unreliable — rows carry groups unrelated to the asset (a surgical
  laser filed under refrigeration). Group by `Asset Description` instead.
- Dates are Excel serials on the 1900 system: `(serial - 25569) * 86400000` ms since epoch.

## Other exports in `BEMMP DATA/` (not wired up)

| File | Notes |
|------|-------|
| `TM-KL OFFLINE.csv` | 24 cols. Manually logged Kerala tickets. Text dates (`18-Jan-2024`), barcodes formula-escaped as `="1234567"`, has `Ticket Reason`/`Attended By` which the xlsx lacks. |
| `TM-RJ.xlsx` | 23 cols, sheet `sheet1`. Rajasthan. `Complaint ID`, text timestamps, `Final Closed` status, barcodes prefixed with a parenthesised GS1 code. |
| `TM-UP1.xls`, `TM-UP.xls` | Legacy binary `.xls`, not OOXML — cannot be unzipped, needs a converter. |
| `KL PM`, `KL CAL`, `AP PM`, `AP CAL` `.xlsx` | Shared **schedule** schema (`Schedule Id` = `WO/2026/…`), 20-22 cols. `Delay Days` is signed text (`+130 days`). Open items read `Not Yet Completed`. Note the double space in `Facility  Type`. |
| `RJ CAL.xlsx`, `RJ PM.xlsx` | Report-style export — **data starts at row 4**; rows 1-3 are a print header. |
| `TM - Care 360.xlsx` | 29 cols. Multi-state private program with a `State` column. Job-lifecycle timestamps and `TaT`. Uses inline `t="str"` cells, no shared-string table. |
| `TM - PVT Service.xlsx` | 26 cols. Same family as Care 360. |

Files under `BEMMP DATA/` are refreshed exports from a SharePoint sync and get overwritten
periodically — treat them as read-only inputs and never edit in place. `desktop.ini` is a
Windows artifact; ignore it.
