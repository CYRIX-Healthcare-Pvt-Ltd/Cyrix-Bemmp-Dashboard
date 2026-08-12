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

**The chart stops before the reference date** for the same class of reason as FTFR, but a
stronger one: the last `window` days are not "no breaches yet", they are "no breach
*possible* yet". Plotted, that drew a cliff to zero that got read as the backlog clearing.
`penaltyEligibleThrough` is `referenceDay - shortestWindow - 1` — shortest, because a date
qualifies as soon as *any* criticality could have breached in it, which matters only for
Andhra's two windows.

Both cutoffs drop whole periods, never part of one: a period survives if it *starts* on or
before the cutoff, so a partly-settled week or month still plots and only the daily view
trims to the exact date. The caption says why the line stops short, or the missing tail
reads as missing data.

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

Three things to keep in mind:

- **Per-day penalty counts open tickets only.** It is a burn rate — what the contract
  costs today — so a closed ticket contributes nothing however much it accrued before it
  closed; that is the closure penalty's job. `accruingRows()` enforces this. Without the
  bucket test it also picks up every ticket that merely *finished* accruing inside the
  window, which in Kerala roughly doubled both the count and the daily figure.
- **Closure penalty is scoped by Resolved Date**, not Logged Date — a ticket logged in
  April and closed in June belongs to June. It is the only view in the dashboard that
  filters on a different date field; `filterRows` takes a `dateField` option for it.
- **Accrual ignores the logged-date window entirely** (`dateField: null`). A call logged
  in May is still running up penalty in July, which is exactly what `AN`'s clamp encodes.
  Filtering accrual by logged date silently understates it.

The two measures are disjoint by construction — open tickets carry a per-day rate and no
closure figure, closed tickets the reverse — which is what the `Per-day ₹` and `Closure ₹`
columns in the ticket grid show. The grid renders them only when the state has a rate card.

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

### The chart measures it differently, on purpose

`buildSeries` divides by calls **logged**, not by calls resolved — the one place in the
dashboard that does. Per period the resolved-only denominator is not just noisy, it is
systematically wrong: it holds only the calls resolved *so far*, and the quick ones land
first. Every recent period therefore starts at **100%** and sinks for weeks as the slow
resolutions arrive. Measured on the real artifact, 21 and 22 Jul both read 100.0% under
the old denominator against a settled baseline of 55–60%. Dividing by calls logged is final
two days after the period and never moves again, which is what a trend line needs.

It also applies the Sunday rule to the numerator, via `isFirstTimeFix`. A plain
`resolved - logged <= 1` fails every Saturday, whose next day nobody works: Sat 18 Jul
scored 30.6% against weekday neighbours at 60%, a sawtooth that was an artefact of the
service week. With the rule it reads 45.7%.

**The chart also stops before the reference date.** `ftfrSettledThrough` returns the newest
logged date whose verdict is final, bounded by `maxResolvedDay` as well as the logged
range — the export is usually taken part way through its last day, which on this dataset
carries 39 calls against a normal 270 and almost no resolutions. The Sunday rule is why it
walks back a day at a time instead of subtracting a constant. Worked examples, all
confirmed against how the business reads it: today Fri 31 Jul → 29 Jul; Mon 27 Jul → Fri
24 Jul; Tue 28 Jul → Sun 26 Jul.

**The KPI tile still uses the old definition** — `fixes / resolved` with a flat one-day
window, over the whole selected range, where the unsettled tail is a rounding error. It is
one of the figures `BASELINE.md` pins, so aligning it to the chart means regenerating that
baseline and re-checking the numbers with the business. Until that happens the chart reads
several points lower than the tile, because its denominator is larger. The tooltip prints
`Fixed in window` next to `Calls logged` so the percentage on screen can always be checked
by hand.

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

## Assistant

`AssistantPanel` answers plain-language questions, by voice or text, in six languages.

**The model never sees ticket data.** It receives only the question and the fixed
`QUERY_TOOL` schema, and returns a small JSON spec — measure, dimension, order, limit,
range, optional filter. `runQuery` in `src/data/assistant.js` executes that spec against
the typed arrays and `describeResult` composes the answer sentence locally. Consequences
worth preserving:

- Figures quoted back are the dashboard's own, so the sentence and the chart cannot
  disagree, and nothing is hallucinated.
- Engineer names, phone numbers and facility names never leave the browser.
- Free-text filter values ("palakkad") are resolved against the dictionaries here, which
  is why no dictionary needs to be sent either.

Translation sends only the already-composed sentence, so the numbers in it are fixed
before any model sees them. Voice in and out use the browser's own Web Speech engines —
no audio is uploaded.

**`order` is a direction, not a verdict.** Which end of a ranking is the bad one depends on
the measure: for turnaround the slowest is worst, for FTFR the lowest is. Models read
"worst" as one fixed direction, which answered "which district has the worst closure TAT"
with the three *fastest* districts. Each measure declares `worstOrder`, and `applyPolarity`
resolves the question's quality word against it after the model replies — the same
after-the-fact correction pattern as `disambiguateMonthYear`. It fires only on a quality
word, so "the highest average resolution time" states its own direction and is left alone.

Engineer labels go through `parseEngineer` before display, or the answer reads a phone
number aloud.

**Voice.** Speech input is the browser's own engine, so no audio is uploaded. Output
prefers OpenAI's multilingual model: Windows ships no voice for Malayalam, Telugu, Tamil
or Kannada, and `speechSynthesis` responds by silently substituting an English voice that
reads the script with English phonetics rather than failing. `hasNativeVoice()` is the
check that routes around it; the browser engine remains the fallback when no key is
available. `stopSpeaking()` halts either engine.

**Keys.** The key lives behind a proxy — `serve.mjs` at `/api/assistant`, or the
Cloudflare Worker in `serverless/` for static deployments, selected by
`VITE_ASSISTANT_URL` at build time. Each user supplying their own key is only the
fallback when no proxy is reachable.

A key must never be committed, bundled, or served to the page. Fetching a key from the
backend and holding it in the browser is equivalent to publishing it: it appears in the
network tab and the endpoint serving it can be called by anyone. The key stays server-side
and the request travels to it.

## UI conventions

**Tabs**: `Dashboard` carries the KPI grid, the chart and the breakdowns — everything that
answers "how is the contract doing". The rest are working surfaces and deliberately do not
repeat the tiles above themselves.

`Open calls` holds three sub-tabs over the same backlog: `Open`, `Unresolved`, and
`Ticket tracker`. The tracker is the daily penalty meeting — the same open rows, in the
form the meeting works through them — which is why it is a sub-tab rather than a tab of its
own. `callView` is either a bucket id or the `TRACKER` string, and `TRACKER` is a string
precisely so it can never collide with a bucket. The tracker only appears for accounts that
may edit it, and the global filter bar applies to it exactly as to every other view.

**Drill-down** is one component, `DrillExplorer`, used by the open, penalty and repeat
tabs. It takes a row set and a mode (`tickets` or `repeats`), and every breakdown bar
pushes onto a drill path. The dimension order is district → facility → equipment →
manufacturer → engineer → department → facility type, matching how a service manager
narrows down. In `repeats` mode the repeat analysis re-runs at each level, so "repeat"
keeps meaning ">1 call on the same asset" inside whatever has been drilled into rather
than filtering a precomputed all-time list.

Two things drill without being dimensions, so neither gets a breakdown panel of its own,
and both need their noun in `EXTRA_NOUN` for the breadcrumb. **Ageing** is a range over
`loggedDay` rather than a dictionary id, so its path step carries the band and filters by
predicate under the reserved key `@age`; `showAgeing` is passed only on the open and
penalty tabs, since over resolved calls "how long these calls have been sitting" answers a
question nobody asked. **Why calls are unresolved** is a real column, but one that only
means anything on the unresolved bucket. Both panels hide once their step is on the path —
there is nothing left to choose.

That reason breakdown also appears on the overview. Inside the drill it recomputes at each
level, which is the whole point of it being there: "why is *this facility's* backlog
parked" is not a question an all-time list can answer.

Breakdowns hand `BarList` the **whole** ranking and it shows `TOP_N` — ten everywhere, so
no two panels stop at different depths — until the expander is used. Nothing is capped: a
ceiling would put the tail permanently out of reach, and the tail is where the quiet
outliers sit. Districts set `all` and skip the expander entirely, being a closed set of 14
or 28.

Past ten rows the list scrolls inside its panel rather than stretching it, and threads its
own series colour through `--bar-color` so each scrollbar matches the bars it belongs to.
There is a note in `styles.css` about why `content-visibility` is not used on those rows;
read it before adding it.

**Aggregation must stay one linear pass per breakdown.** It runs on every filter and drill
change. Anything shaped like "for each asset, scan the rows" is O(assets x rows) — 11
billion operations at Kerala's full scope — and will hang the tab. Add new breakdowns to
the single pass, the way `analyzeRepeats` collects its rows.

**Colour**: chart series come from the validated data-viz palette and are stepped per
theme; brand red and navy are chrome only (logo, accents, state switcher) and never encode
data. Both palettes hang off `data-theme` on the root and nothing else — an inline script
in `index.html` stamps it from the same `localStorage` key `ThemeToggle` writes, before the
first paint. That is what lets the stylesheet carry **one** dark palette: the earlier
`prefers-color-scheme` copy had already drifted out of step with the `[data-theme='dark']`
one, which is the failure mode a duplicated token list always has.

**Date range**: the dashboard opens on the **current month of the data**, not all time and
not the calendar month — the export lags reality, so "this month" is derived from
`meta.dateRange.maxDay`. Every preset is anchored to `maxDay` for the same reason.

**Charts**: one component, `MetricChart`, with the metric passed in. All four series
(volume, FTFR %, repeats, penalty) come from a single `buildSeries` pass so switching tabs
costs nothing and the periods always line up. Granularity follows the selected date range
until the user picks one.

Every point carries its value. Labels are placed left to right and each must clear the
last, so a narrow viewport thins them instead of stacking them — two labels on top of each
other is worse than one missing. The latest point always keeps its label and the one before
it gives way, since that is the figure people look for. Widths are estimated from the
character count rather than measured: `.point-label` is tabular, so every digit is the same
width and the estimate cannot drift out of step with what renders.

**Glass**: every raised surface — masthead, panel, KPI tile, filter bar, drawer, assistant,
tooltip — shares one recipe, declared once as a selector list in the *glass* section of
`styles.css` rather than per component: a translucent tint, `backdrop-filter` with the blur
**and** a saturation lift, a lit lip inset along the top edge and a shaded one along the
bottom. Blurring alone desaturates whatever is behind it, so without the `saturate()` the
colour arriving from the backdrop turns grey the moment a panel covers it.

Four tokens carry the weights: `--glass` (panel), `--glass-strong` (overlays, which sit
over live content and must stay legible), `--control-bg` (a pill *on* a surface) and
`--track-bg` (a groove cut *into* one). The last two flip direction with the theme —
lighter than their backing in dark, darker in light — because that contrast direction is
the only thing telling the eye which is raised.

`--glass-ring` is the outer hairline and is the one that is easy to get wrong: on the light
page a white border against a white panel draws nothing, so the edge that actually
separates them is a faint ink line *outside* the border. Dark mode fills the same slot with
a dark line. Dropping it makes every panel look like it is floating on shadow alone.

Controls are pills throughout (`--radius-pill`). A rounded rectangle among this much
curvature reads as something the restyle missed.

**Backdrop**: `Backdrop.jsx` is two very wide, heavily blurred washes of brand colour in
opposite corners, and nothing else. Only brand red and navy appear there; a backdrop
borrowing the chart palette reads as a legend. It exists *for* the glass as much as for
itself — a frosted surface over a flat page has nothing to refract and just looks grey — so
the alphas are set low enough that the wash never registers as a shape.

It does not move, and there is no motion toggle. Earlier versions had an animated ambient
layer (ECG traces, drifting orbs, corner spheres); on a dashboard people read for long
stretches, anything moving behind the figures competes with them every time it passes.
`prefers-reduced-motion` is still honoured, but it now covers only the interface's own
entrances — panels rising in, the drawer sliding, bars growing.

**Filters**: the bar is collapsed at every width and the panel opens on demand. It cost a
third of the first screen open by default, and most sessions never touch it because the
default range is the one people want. Collapsed, the row carries a one-line summary of
what is selected — without it the figures below would have no visible provenance — and a
reset that appears only once something is applied.

**Mobile**: the filter bar collapses behind a toggle below 860px (the `[hidden]` attribute
needs the `!important` reset in `styles.css` — a class rule like `.filters { display: flex }`
beats UA specificity otherwise). The KPI grid steps 4 → 3 → 2 columns so eight tiles never
leave a short final row.

The masthead also drops `flex-wrap` there, not just the direction. A wrapping *column* flex
container takes its width from its widest item instead of giving items the container's
width, so the header sized itself to the state switcher and clipped the brand block against
its own `overflow: hidden`.

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
