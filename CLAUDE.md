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
npm test                    # unit tests, no deps, ~250ms
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

`npm test` runs `test/*.test.mjs` on **`node:test`** — no runner, no config, no dev
dependency, which suits a project whose whole toolchain is Vite and one Postgres driver.
The fixtures are synthetic (`test/fixture.mjs` builds the same concatenated `Int32Array`
columns `datasetFrom` slices), so the suite runs on a fresh clone with no workbooks and no
`BASELINE.md` — both are gitignored. What it covers is the set of rules this file calls
easy to get wrong, and every case is one that *was* got wrong at least once: the three
buckets and the literal `" "`, FTFR's Sunday rule and settled cutoff and logged
denominator, penalty's strictly-greater window, the money clamps and the two disjoint
measures, barcode padding and case folding, the saved view's label round trip, the
financial year's April boundary, and each of the assistant's after-the-fact corrections.
Add to it when fixing a figure — a rule with a test is a rule that stays fixed.

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

Kerala's `D Zone` is North/South and is **complete** — 0 of 265,769 rows blank — and maps
one-to-one onto district, so it needs no lookup table of its own. Andhra has no such column,
which is why zone is present or absent by contract everywhere it appears: the drill
dimension, the filter, and the tracker and ticket-list columns all test the dictionary
rather than the state id.

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

A call logged today and resolved today or tomorrow is a first-time fix. The window is
`FTFR_MAX_DAYS`, and the rule lives in `shared/schema.mjs` as `isFirstTimeFix` — the one
place both the offline build and the browser read it from, so the headline figure the
artifact carries and the figure the page computes cannot drift apart.

**Sunday is not a service day.** A call logged on Saturday still has Monday, and one logged
on Sunday has Monday too, so `ftfrWindowEnd` steps over a Sunday rather than counting it.
Without the rule every Saturday scored about 30% against weekday neighbours at 60% — a
sawtooth that was an artefact of the service week, not of anyone's performance. The
business's own spreadsheet applies the same rule, which is how it was confirmed.

**The denominator is calls logged**, not calls resolved. Dividing by resolved asks "of the
ones we closed, how many were quick", which leaves out every call still open and so
flatters the figure — it also moves for reasons that have nothing to do with speed. This
was wrong on the KPI tile until 13 Aug 2026: the tile read 59.3% (888/1,498) where the
business's sheet read 49%. Checked against that sheet day by day for 1–10 Aug, every
logged count and every fix count matched exactly; the figure is now 926/1,896 = 48.8%.

**Only settled days count.** A call logged yesterday still has today to be fixed in, so
counting it as a miss is not a low score but an unfinished one — and the last days of an
export are always the least resolved. `ftfrSettledThrough` returns the newest logged date
whose window has closed, and both the tile and the chart stop there. Worked examples, all
confirmed with the business: today Thu 13th → 11th; Mon → Fri; Tue → Sun.

### The chart and the drill measure it the same way

`buildSeries` divides by calls **logged** too. Per period the resolved-only denominator is
not just noisy, it is
systematically wrong: it holds only the calls resolved *so far*, and the quick ones land
first. Every recent period therefore starts at **100%** and sinks for weeks as the slow
resolutions arrive. Measured on the real artifact, 21 and 22 Jul both read 100.0% under
the old denominator against a settled baseline of 55–60%. Dividing by calls logged is final
two days after the period and never moves again, which is what a trend line needs.

So does the **drill**, which is the one that was missed when the tile was fixed. The FTFR
tab feeds `DrillExplorer` a row set of its own — every call *logged* through
`ftfrSettledThrough`, not `resolvedRows` — because a call still open is a call that was not
fixed in its window and belongs in the denominator. It read 58.9% for South zone against a
tile showing 49%; the two now share a denominator exactly, and the zone rates weight up to
the headline. `Avg resolution` still takes `resolvedRows`, because an open call has no
resolution time to average — the two measures on that tab deliberately run over different
rows, and the row set is chosen by `perfId`, not shared.

`ftfrSettledThrough` is bounded by `maxResolvedDay` as well as by the logged range — the
export is usually taken part way through its last day, which on this dataset carries 39
calls against a normal 270 and almost no resolutions. The Sunday rule is why it walks back
a day at a time instead of subtracting a constant.

The tooltip prints `Fixed in window` next to `Calls logged`, and the KPI tile's note reads
"926 of 1,896 logged", so the percentage on screen can always be checked by hand.

The build-time KPI in `shared/schema.mjs` applies no settled cutoff: it is an all-time
figure over hundreds of thousands of rows, where the last two days are a rounding error.
It is one of the numbers `BASELINE.md` pins — regenerate it after any change here.

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

`AssistantPanel` is **Cyra**, and answers plain-language questions, by voice or text, in
six languages. She is given the **whole conversation**, not a trailing window — four
messages was enough for "and for Palakkad?" and nothing else, so a district discussed three
turns ago was already forgotten. `HISTORY_LIMIT` caps the stored thread at forty turns and
the bin button clears it; nothing else expires it.

**She does not inherit the filter bar.** `neutralFilters` is her baseline — the whole
contract, every date, nothing selected — and only what the question says narrows it. She
used to be handed the dashboard's own filters, which made her answers depend on page state
nobody is thinking about while typing: the same question gave a different number on This
month than on All time, and neither the question nor the answer mentioned a date, so the
figure read as wrong rather than as scoped. Worse, a district left in the panel silently
intersected with the district in the question and the answer came back zero. The footer
therefore always names the real window, since the tiles beside it may be on another one.

**She knows who is asking**: the signed-in account's first name and role, and nothing else
— no ticket data has ever reached the model. `firstName` in `supabase.js` is the one place
that decides what somebody is called, and the masthead's account chip reads from it too;
the employee code stays in that chip's tooltip, because it is what the database and the
seed sheet call the account.

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

**"Penalty" on its own means money.** There are three penalty measures and the model reaches
for `penalty` — the call count — because it has the shortest name, so "which district has
the highest penalty" answered "Thiruvananthapuram, 11", a number of calls where a figure in
rupees was asked for. `resolvePenaltyMeasure` swaps it to `perDayPenalty` after the model
replies, matching the Penalty ₹ tab's own default. Two things hold it back: a question that
names the count keeps the count ("how many penalty **calls**", and the equivalents in the
five languages), and a contract with no rate card keeps it too — Andhra has none, so
swapping there would turn a real answer into "this cannot be calculated".

**She can read two Postgres tables, and only two.** `meeting_note` and `account_audit` get a
second tool, `look_up_record` in `src/data/records.js`, because they genuinely live in the
database, are small and are relational — everything else she answers comes out of
`tickets.bin` in this browser. It handles "what did we decide on ticket 285716", "which
tickets are waiting on a PO", "who reset KLCoord's password".

The boundary is the ticket side's, unchanged. **The model never sees a row**: it returns a
spec — which table, which ticket, which field — and `runRecordQuery` runs it, with the
sentence composed here exactly as `describeResult` does for figures.

**RLS decides what is visible, not this file.** Every query goes through the browser's own
Supabase client carrying the signed-in session, so `meeting_note_read` (`in_scope(state)`)
and `account_audit_read` (`is_admin()`) apply as they do everywhere else. There is
deliberately **no service key** and no `api/` route: putting one there would mean
re-implementing scope in JavaScript that the database already enforces, and the copy is what
would eventually be wrong. Verified live — a Kerala coordinator sees 5 Kerala notes, 0
Andhra, 0 audit rows; an Andhra coordinator sees none of Kerala's.

A ticket with nothing recorded and a ticket outside your contracts get the **same** answer,
on purpose. Distinguishing them would confirm which tickets exist outside your scope, which
is the thing the policy is there to withhold.

Answers carry `sensitive: true`. Purchasing remarks are free text and could say anything
somebody typed, and `translateSentence` is the one path that would put a composed sentence
in front of a model — the flag is what stops that being wired up over this later.
`ticketInQuestion` pulls a ticket number straight out of the text, so "285716" needs no
model round trip at all.

Engineer labels go through `parseEngineer` before display, or the answer reads a phone
number aloud.

**Voice.** Speech input is the browser's own engine, so no audio is uploaded. Output
prefers OpenAI's multilingual model: Windows ships no voice for Malayalam, Telugu, Tamil
or Kannada, and `speechSynthesis` responds by silently substituting an English voice that
reads the script with English phonetics rather than failing. `hasNativeVoice()` is the
check that routes around it; the browser engine remains the fallback when no key is
available. `stopSpeaking()` halts either engine.

**Language is detected from the script, for typed questions only.** Each of the five
languages owns a Unicode block, so `detectLanguage` is a lookup rather than a guess and a
question typed in Malayalam sets the panel to Malayalam without anyone touching the picker.
Latin text returns null — "hello" and "ente ticket evide" are both Latin, and telling those
apart needs a model, not a range check; English is the default anyway.

Speech **cannot** work this way. The Web Speech API is told which language to expect before
it hears anything, so the picker has to be right before the mic is pressed; detecting from
the transcript only helps the next question. Real voice auto-detect means uploading audio to
Whisper, which would give up the "no audio leaves the browser" property above — a trade
worth making deliberately, not by accident. The choice is remembered in `storedLanguage`,
so somebody who works in Malayalam sets it once.

**Keys.** The key lives behind a proxy — `serve.mjs` at `/api/assistant`, or the
Cloudflare Worker in `serverless/` for static deployments, selected by
`VITE_ASSISTANT_URL` at build time. Each user supplying their own key is only the
fallback when no proxy is reachable.

A key must never be committed, bundled, or served to the page. Fetching a key from the
backend and holding it in the browser is equivalent to publishing it: it appears in the
network tab and the endpoint serving it can be called by anyone. The key stays server-side
and the request travels to it.

## Accounts, and the server side

Two things cannot happen in a browser: reading a bearer credential, and creating a login.
Both need the Supabase **service key**, which bypasses row-level security entirely. So both
live in `api/` — Vercel functions holding that key — and the rule for everything in that
directory is that the key is used and never returned, logged, or echoed in an error.
`scripts/serve.mjs` covers the same ground for the local and LAN builds.

| Route | Does |
|---|---|
| `GET /api/assistant/health` | whether a key is configured. Unauthenticated, answers yes/no |
| `POST /api/assistant` | one chat round trip |
| `POST /api/assistant/speech` | text to speech, returns audio |
| `/api/users` | list, create, patch, `?do=reset`, `?do=disable` |

The assistant endpoints **require a signed-in session**, checked by handing the caller's
token back to GoTrue. Without that the proxy is an open OpenAI relay on a public URL billed
to Cyrix — the key being hidden from the browser is not the same as the endpoint being safe
to leave open. The model is pinned server-side for the same reason.

`/api/users` re-checks `role = 'admin'` against the database on every request. The hidden
tab is a courtesy; `profile_admin_write` is the control.

**Every account action is audited.** `meeting_note` had a trail since 0001 and nothing else
did, which left the operations that matter most unrecorded: an admin could create a login,
reset anybody's password to their employee code, change a role or revoke access, and
"who reset my password on Tuesday" had no answer. `account_audit` is written by
`recordAction` in `api/_lib/server.js` on every path through `api/users.js`, and read back
at `GET /api/users?do=log`.

Three properties hold it up, and all three are worth keeping:

- **Append-only by construction.** The table has a select policy for admins and **no
  insert, update or delete policy at all** — the same technique `app_secret` uses. Only the
  service key can write, and only `api/users.js` holds it. Verified against the live
  database with an admin session: select returns rows, insert is refused 403, and
  update/delete affect zero rows. The party being audited cannot edit their own trail.
- **Codes as well as uuids.** `profile` is readable only for your own row, so a log keyed
  on uuids alone would need a definer function per row to be legible — which is exactly
  what happened to `meeting_log`. The codes also keep a row meaningful if its subject is
  ever removed, which is why `target_id` is deliberately not a foreign key.
- **Never a password.** `reset` records that a reset happened and by whom. The value is the
  employee code and already known; a log holding credentials is a log worth stealing.

`recordAction` returns a message rather than throwing. It runs after the action has already
succeeded, so throwing would report a failure that did not happen — the caller surfaces the
miss as a `warning` on the response instead.

**The OpenAI key lives in `app_secret`**, not in a deploy variable. That table has RLS on
and **no policy at all**, which is the whole design: with none, anon and authenticated match
no row and it is invisible to every browser however the request is shaped. Only the service
key can read it. Keeping it there rather than in an environment variable means rotating it
is an update with no redeploy — which matters, because rotating it is the response to it
leaking. `node scripts/set-secret.mjs openai_api_key OPENAI_API_KEY` reads the value from
`.env.local` and never takes it on the command line.

Vercel therefore needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (no `VITE_` prefix — that
prefix is what puts a variable in the bundle) alongside the two `VITE_SUPABASE_*` ones the
browser uses.

`vercel.json`'s rewrite is `/((?!api/).*)` rather than `/(.*)`: Vercel does check the
filesystem before rewrites, so functions resolve either way, but the exclusion means a
later rewrite rule cannot quietly swallow them. That file is validated against a schema
permitting **no unknown properties** — a `"//"` comment key fails the deployment before the
build starts, which is why the reasoning lives here instead.

**The admin role.** `admin` joins the four business roles rather than outranking them: a
director is a read-only audience for the figures, an admin manages accounts and has no
special claim on the data. Their `scope` column is left **empty** and `in_scope()` grants
every contract from the role — writing `{'kl','ap'}` there would be a copy that goes stale
the day a third contract is added. `canSeeState` makes the same test on the client.

**Only two role ids are load-bearing**, which is what makes adding a designation cheap.
`admin` gates the Accounts tab, and `director` is the one role that cannot type in the
meeting grid — `canEditMeeting` is `role !== 'director'` and `meeting_note_write` leans on
`is_director()`. Everything else is a job title, so `zonal_manager`, `district_incharge` and
`divisional_manager` (migration 0008) needed an enum value and two label lists and no policy
at all. If one of them ever has to be read-only, that is a change to `is_director()` **and**
to `canEditMeeting`, and it must be made in both or the client and the database will
disagree about who may edit. The role list lives in three places that must stay in step:
the `app_role` enum, `ROLES` in `src/data/users.js`, and the `ROLES` set in `api/users.js` —
the server's is the one that decides, since the page can send anything.

The account list edits **name** in place, saved on blur like the meeting grid, because
correcting a spelling should not need a second control. The employee code is not editable:
it is what `account_audit` records, what the seed sheet calls the account and what the
default password is, so it is an identity rather than a detail.

**The default password is the employee code.** There is an asymmetry in GoTrue worth knowing
before changing any of this: creating a user with the admin key *bypasses* the password
policy, while updating one *enforces* it. So a code shorter than the minimum can be given
that password once, at creation, and never again — which is why `create` cannot fail on it
and `reset` can. The form says so before it happens. Recreating the account would get around
it, but it issues a new user id and `meeting_note.updated_by` points at the old one, so
every entry that person made would lose its author; that is not a trade to make on the
admin's behalf. For the same reason accounts are **disabled, not deleted**.

`scripts/seed-users.mjs` takes `--only CODE`. A bare re-run is less harmless than
"idempotent" suggests — refreshing a short-password account takes that delete-and-recreate
path — so adding one account should not touch the other seven.

## UI conventions

**Shared datasets**: a TM export uploaded in the browser is published to Supabase Storage
as `<state>/meta.json.gz` and `<state>/tickets.bin.gz`, so one upload serves the team —
without it a deployment with no server artifact is empty until every person finds the
workbook themselves. The *built artifact* travels, not the workbook: parsing already
happened in the uploader's browser and nobody else pays for it again. Kerala's is 27 MB, so
both objects are gzipped with `CompressionStream` first.

**Publishing must never fail quietly.** It once did: the whole block was wrapped in
`if (isConfigured())`, so a build with no Supabase connection skipped it without a word and
the uploader was left believing the team had the file. A Kerala export sat in one browser
for a day that way while everyone else saw the upload prompt — and from the dashboard the
two are indistinguishable, because the figures are on screen either way. A skip now reports
itself as loudly as a failure, each contract shows whether the team actually has it, and
**Share** publishes an artifact already sitting in IndexedDB. That last part matters:
without it the only way to recover was to find the 46 MB workbook and parse it again.

**Whichever export is newer wins**, not whichever is closest. The local upload used to take
precedence unconditionally, which quietly broke the thing publishing exists for: somebody
who uploaded on Monday saw Monday's figures all week while the team had Thursday's, and
nobody would notice, because numbers look like numbers. A tie goes to the local copy — a
tie means it is the same export and that one is already on disk. Below both is whatever the
server build shipped, which is only ever as fresh as the last deploy.

**Every publish writes a new folder** — `<state>/<version>/` — and `dataset.version` is the
pointer. The two objects used to be overwritten at one fixed path each, and Storage serves
them `cache-control: max-age=3600`, so for an hour after every publish a browser could hold
the *previous* 27 MB `tickets.bin.gz` in its own HTTP cache while fetching the new
`meta.json.gz` over the network. That is a meta describing 270,293 rows paired with a
buffer holding 270,030: every figure read out of the wrong column. The reader's size check
catches it, but only by refusing to load at all, and one publish took the deployment down
for a morning that way. It was never a race — anyone who opened the dashboard in the hour
before a publish hit it.

Immutable paths remove the failure rather than narrowing the window: bytes behind a URL
never change, so caching them for a year is correct, and switching versions is a one-row
update, which is atomic. A publish that dies halfway leaves a folder nobody points at. The
old flat paths are still read when `version` is null. A publish sweeps the version it
replaced, best-effort — the upload has already succeeded by then, and a stale folder is
housekeeping, not a failure to report.

**A shared artifact that will not load must not take the page down with it.** There is
usually a good copy behind it — this browser's own upload, or the server build — and an
error screen hides all of them. `App.jsx` falls through and logs; it does not swallow,
because the next thing shown is a *different* export.

`dataset.uploaded_at` is re-read on focus, on `visibilitychange` and on a five-minute
timer, so a page already open in another office picks up a publish without a reload.
`reloadShared` compares the timestamps and keeps the previous object when nothing changed —
the loader depends on that object's identity, so setting it unconditionally would
re-download 27 MB on every poll. Only the provenance lives in Postgres; 265k rows in a
table would throw away the whole reason the columnar format exists.

**Layout**: the masthead spans the full width; below it a collapsible rail carries the
sections and the working column takes the rest. The tabs were a horizontal strip, but six
labels already filled a laptop's width, so it scrolled sideways and cost a band of the
first screen on every tab. Collapsed, the rail is 60px of icons and hands 148px back to the
content. Below 860px it becomes a scrolling strip along the top — a sidebar on a phone is
either most of the screen or a hamburger nobody opens. The strip keeps its icons, because
they are what carries each section's colour, and it already scrolls sideways.

**Opening it widens the column; it never floats over the work.** An overlay covers exactly
the tiles somebody opened the nav to navigate away from, and a number half-hidden behind
chrome is worse than one off the edge of the screen. So `--nav-w` is what animates and the
working column follows it — which needs `@property` to register it as a `<length>`, since an
untyped custom property cannot interpolate and `grid-template-columns` snapped. This is a
layout animation, normally the thing to avoid, and it earns the cost only because there is
no transform that pushes a grid column. Its one real expense is `MetricChart`, which re-reads
its own width as the column moves; that is why the observer there rounds and skips
no-op updates.

**It puts itself away once the work is touched**, at every width above the strip: a press
anywhere outside it, or Escape. **Picking a section does not close it** — that closes on
somebody *using* the nav, which made the names useless for the one thing they are for.
Open it to read the labels, press Penalty, and it shut; comparing two sections then meant
reopening it every single time. Nothing is remembered between visits, for the related
reason that a nav which shuts itself has no resting open state worth restoring. `HAS_RAIL`
in `SideNav.jsx` is the one place that decides, and it gates every auto-close so the phone
strip is never subject to rules written for a column that is not on screen.

The icon sits at the same x in both states — one `padding-left` puts it dead centre of the
60px rail and at a normal indent in the 208px column — so the labels appear beside it
rather than shunting it along. The labels fade asymmetrically: 60ms late arriving, immediate
leaving. Text fading in while the container behind it is still moving reads as a smear.

The filter panel is a right-hand drawer over the content rather than a band across it, so
it costs nothing when closed, which is most of the time.

**Tabs**: `Dashboard` carries the KPI grid, the chart and the breakdowns — everything that
answers "how is the contract doing". The rest are working surfaces and deliberately do not
repeat the tiles above themselves.

`Penalty` holds three sub-tabs over one backlog: `Per-day penalty`, `Penalty calls`,
`Closure penalty`. Penalty calls used to be a section of its own, which asked the same
question twice — a per-day figure *is* that backlog counted in rupees, and reading either
without the other is how a handful of expensive calls hides behind a crowd of cheap ones.
The calls view carries `money: false`, which is also what lets Andhra show it: it needs no
rate card, so it is the one penalty view that works there.

**A KPI tile takes the colour of the section it opens**, from the same `--nav-*` token that
section's rail icon uses — not a copy of it. Press the amber tile, land on the amber
section. The accent rail on the tile's left edge reads from the same token and lights on
hover; the icon square carries the colour at rest, so both lit at all times would be the
same fact stated twice.

`Open calls` holds three sub-tabs over the same backlog: `Open`, `Unresolved`, and
`Ticket tracker`. The tracker is the daily penalty meeting — the same open rows, in the
form the meeting works through them — which is why it is a sub-tab rather than a tab of its
own. `callView` is either a bucket id or the `TRACKER` string, and `TRACKER` is a string
precisely so it can never collide with a bucket. The tracker only appears for accounts that
may edit it.

**The tracker is the one view the date window does not apply to.** It takes `undatedIdx`,
for the same reason penalty accrual does: a call logged in October with no resolved date is
still open in August and still on the meeting's agenda, but a logged-date window drops it —
and the ones it drops are the oldest, which is to say the most overdue and the most
expensive. On the Kerala export the default month view showed **639 of 931**, hiding 292
open calls, the oldest logged 28 Oct 2025. The dimension filters still apply; only the date
range is lifted, and the caption says so, because a count that disagrees with the "This
month" summary above it otherwise reads as a fault.

It stays **open only**, not everything without a resolved date. Parked calls carry a Ticket
Remark putting them outside service scope, they accrue no penalty at all, and Kerala has
7,525 of them against 931 open — enough to bury the agenda ten to one in rows that cost
nothing.

**The log column** surfaces `meeting_note_history`, which the audit trigger has been writing
since 0001 and which nothing had ever shown. It reaches it through two `security definer`
functions rather than the table directly, for one reason: `changed_by` is a uuid, and
`profile` is readable only for your own row, so a coordinator cannot resolve a colleague's
id to a name. `meeting_log_summary` returns a count and the last author per ticket for the
whole tab at once — a summary, because nine hundred tickets' full history is not something
to fetch to draw a column — and `meeting_log` returns one ticket's entries on demand. Both
re-check `in_scope` themselves, since a definer function bypasses the policy that would
otherwise have done it. A save advances the count locally instead of refetching, or the
meeting would issue a request per field typed.

**Two money columns, not one.** `Penalty ₹` is the day rate — what this ticket costs for
every further day it stays open — and `Accrued ₹` is what it has cost so far, from the day
its grace window closed to the reference date. Either alone misleads: on the Kerala backlog
a ₹10,000/d ticket 23 days old has run up less than a ₹3,000/d one open 97 days, and a
meeting working down the rate column would take them in the wrong order. Accrual is
computed from day 0, not from the selected range, for the same reason the tracker ignores
the date window at all — scoping it would understate exactly the oldest calls.

The tracker carries its own **search and sort** on top of that bar, because the two answer
different questions: the bar decides which calls reach the tab, the search finds the one
somebody just said out loud. Every word must match, so "kannur dialysis" narrows. Sorting
cycles asc → desc → off, and blank entries in a note column sort last in both directions —
they are the rows with nothing decided yet, and floating them to the top of a descending
sort buries the ones that carry an answer. The row count beside the box appears only when
it differs from the caption above it.

**Export takes the search with it.** The Excel button sits at the end of that same tools
row and downloads exactly what is on screen — post-search, post-sort — with all twenty-one
purchasing fields alongside the visible columns. The filename says which it was
(`ticket-tracker-kl-filtered-2026-08-14.xlsx`), because a spreadsheet that left the
building with three of nine hundred rows in it and no way to tell is worse than no
spreadsheet.

It is a real `.xlsx`, written by `src/data/xlsx.js`, and **CSV is not an option here**:
Excel reads `0123456` as 123456 and `285716` as a number, so a CSV silently destroys the
leading zero the whole pipeline works to preserve and stops ticket ids matching the ones on
screen. Writing a sheet lets each column say whether it is text or a number — barcodes and
ids as text, the money columns as numbers so they still sum.

No library, for the same reason there is no test runner: an `.xlsx` is a ZIP of five small
XML parts, and the browser already supplies the hard half. `CompressionStream('deflate-raw')`
emits exactly what ZIP method 8 wants — the same API the dataset publisher uses for gzip —
and entries fall back to stored where it is missing, which is a larger file and an equally
valid one. Strings are inline (`t="inlineStr"`), so there is no shared-string table to build
or index. Dates export as the text the page shows rather than as date cells; a true date
cell needs a number-format table this writer does not carry, and a raw serial would be an
unreadable number.

**The tracker measures penalty differently from the dashboard, on purpose.** The meeting
reconciles this grid against its own `KL Ticket Wise - Tracker.xlsx`, which drives every
figure off the export's own `Down Days` column; the dashboard derives age as
`referenceDay - loggedDay`. Those disagree by exactly one day on 667 of 807 open Kerala
rows — the export does not count the day a call was logged — which moves 13 calls across
the threshold, 184 penalty calls here against the dashboard's 197. A tracker whose numbers
cannot be tied back to the workbook it is checked against in the meeting is a tracker
nobody trusts, so the tracker follows the workbook and the Penalty tab keeps the rule in
*Penalty calls* above. Accrued here is `(downDays - grace) x rate` floored at zero, which
is the workbook's column R, not `penaltyAmountIn`.

**The Summary sub-view** is that workbook's `Summary` sheet, in `src/data/summary.js` and
`TrackerSummary.jsx`. Two blocks over one backlog: by district, and by penalty type. Its
translation is worth keeping straight, because one of the sheet's column letters is a trap:

| Summary | The sheet | Here |
|---|---|---|
| Total open calls | `COUNTIFS(Final!D:D, district)` | every **unresolved** row |
| Penalty calls | `+ P>7 + N=""` | open bucket AND `downDays > window` |
| Penalty | `SUMIFS(Final!R:R, …)` | `(downDays - grace) x rate`, floored |
| Per day | `SUMIFS(Final!Q:Q, …)` | `dayRate` |
| Cont % | `D/SUM(D$21:D$40)` | share of the **per-day** total, not of the count |

`Final!N` is **Ticket Remark, not Resolved Date**. The Final sheet already holds only
unresolved rows — 0 of its 8,516 carry a resolved date — so `N=""` is not a redundant test,
it is exactly this project's OPEN bucket. Which means "Total open calls" counts parked
calls and every penalty column excludes them; that one column is the reason the tracker's
Summary needs `unresolvedRows` from `App.jsx` while its grid takes open rows only, and the
difference between the two is 8,516 and 986.

**Penalty type comes from the meeting, not the export**, so a penalty call nobody has
categorised is in the district block and in no type row. The sheet has that gap and says
nothing about it — its two totals read 420 and 354 — so `untyped` is returned and shown,
because two totals that disagree on one screen otherwise read as a fault. The same applies
to the 4 rows carrying a blank district, which the sheet's `SUM(C4:C17)` drops silently and
which appear here under `—`.

Verified cell by cell against the workbook: feeding its own `Final` rows through
`trackerSummary` reproduces 101 of its 102 Summary cells exactly, the 102nd being that
dropped-district total. Note when checking by hand that Excel's `COUNTIFS` is
case-insensitive and a JS `Map` lookup is not — `KASARGODE` matches `Kasargode` there and
would not here, which is why the pipeline title-cases it at build time.

The twenty-one purchasing fields open in a **dialog**, not an expanded row. As a `colSpan`
cell they were a form wearing a table's clothes: contents lining up with nothing above them,
every following row shoved down the page, and the ticket they belonged to scrolled out of
sight.

**Drill-down** is one component, `DrillExplorer`, used by the open, penalty and repeat
tabs. It takes a row set and a mode (`tickets` or `repeats`), and every breakdown bar
pushes onto a drill path. The dimension order is zone → district → facility → equipment →
manufacturer → engineer → department → facility type, matching how a service manager
narrows down. `dimensionsFor` drops any dimension whose dictionary is empty, which is what
keeps zone off Andhra — every state's export has a different schema, and a column a state
does not supply would otherwise draw a titled panel with one "—" bar in it. In `repeats` mode the repeat analysis re-runs at each level, so "repeat"
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

**The tab mark is the X, not the wordmark** — at 16px `CYRIX HEALTH CARE PVT LTD` is four
grey smears, and the X is the brand's own device anyway. Red on the left half, black on the
right, split through the crossing so each half keeps its own round caps; the halves overlap
slightly because two clip regions sharing an edge leave an anti-aliased hairline between
them. The disc is white because the mark uses black and black needs a light ground, which
makes the hairline round it load-bearing rather than decorative — without it the tile
dissolves into a light tab strip. `public/favicon.svg` is the source; the `.ico` and
`apple-touch-icon.png` beside it are **derived** from that geometry and should be
regenerated, not hand-edited. It is a different drawing from `Logo.jsx` for a different
size, and neither is generated from the other. Colours there are fixed rather than
theme-aware: a favicon that follows the OS theme can go white-on-white in a context neither
branch anticipated.

**Date range**: the dashboard opens on **all time**. It opened on the current month, on the
reasoning that a service review is a monthly conversation — but the first thing anyone asks
of a contract dashboard is what the contract has done, and a landing figure of 2,591 under
a masthead reading 270,293 tickets looks like a fault rather than a date range. Presets are
still anchored to `meta.dateRange.maxDay` rather than to today, because the export lags
reality and a calendar month can be empty.

**The financial year is April to March**, and `This financial year` is a preset of its own
rather than a rename of `Last 12 months` — the two are different windows and coincide only
in March. On the Kerala export, whose newest logged date is 23 Jul 2026, the financial year
holds 21,018 calls against the trailing twelve months' 69,692. The April window is the one
the penalty accounts close on and the one every contract review is written against, so
reading year-to-date off a rolling window answers a different question in the same shape.
`financialYearStart` sits beside `monthStart` in `store.js` because the panel and the
assistant both need it; a second copy is how two definitions of "this year" start
disagreeing. The boundary is the whole rule — January to March belong to the year that
opened the *previous* April — and getting it backwards moves every Q4 figure into the wrong
year without changing how the answer looks, which is why it is tested.

`blankFilters` lives in `query.js` and is the **only** definition of that resting state.
It was a copy in `App.jsx` and another in the panel's Reset, and the copies drifted: one
said all time and the other said this month, so Reset put you somewhere the page had never
been. The badge counts `preset !== 'all'` as a narrowing, so an untouched page shows none.

**A person can save their own default.** Somebody who only ever looks at one district
should not select it every morning, so the panel's `Set as default` writes the current
selection to `localStorage` and `defaultFiltersFor` is what the page then opens on —
including after an upload. Reset returns to *that*, not to blank, or there would be three
states where the user thinks there are two. The same button becomes `Reset default filter`
once one is saved, and clearing it puts the page back on all time in the same press.

Two things it stores deliberately. It is keyed **per contract**, since a dictionary id
means nothing outside the state it was built from. And it stores **labels, not ids** —
dictionaries are interned in first-seen order while parsing, so every new export renumbers
them and a saved id would quietly become a different district; a label that no longer
resolves is simply dropped, which is the right answer for a facility that has left the
contract. Dates are clamped to the export's own range on the way back in.

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

It narrows by **zone, district, facility and equipment**, declared once as `FILTER_DIMS` in
`query.js`. Facility type and criticality are deliberately not offered: neither is how
anyone asks a question of this data, and criticality reads as a business control when it is
really an input to the penalty window, which the SLA applies whatever is selected. They are
still *filterable* — `FILTERABLE` is the wider list the engine honours, because the
assistant sets those keys straight from a question.

Facility and equipment are 1,572 and 556 entries, so they are type-ahead over a native
`datalist` rather than a select — the browser's own list filters as you type and opens the
picker a phone user already knows. Render the **whole** dictionary into it: a cap does not
shorten what the person sees, since the browser already filters that, it just silently
removes the tail, and a facility late in the alphabet then suggests nothing.

Controls whose values are short — the two dates, zone and district — pair onto one row via
`.field-pair`; `auto-fit` means a contract supplying only one of them fills the row instead
of sitting in half of it.

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
