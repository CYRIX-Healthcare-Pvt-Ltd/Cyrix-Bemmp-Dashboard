# Publishing the BEMMP dashboard

There are two ways to run this, and they differ in where the ticket data lives.

| | Server build | Upload build |
|---|---|---|
| Command | `npm run build` | `npm run build:static` |
| Bundle size | 37 MB (data included) | **235 KB (no data)** |
| Where data comes from | prebuilt artifacts on the server | each user's own `TM-*.xlsx`, read in their browser |
| Refresh button | yes | no — users re-upload |
| Safe on a public host | **no** | **yes** |

The upload build is what makes GitHub Pages workable, so read that section before
dismissing it.

## The one thing to settle first

**The artifact contains engineer names and mobile numbers** (from the `Assigned` column)
alongside every facility, asset and ticket in both contracts. All of it is fetched by the
browser, so whoever can open the page can read all of it. "Nobody will guess the URL" is
not protection.

That rules out publishing the **server build** to any unprotected host. It does *not* rule
out the **upload build**, which ships no data at all — see below.

## Recommended: run it on one machine, share it over a tunnel

This is the only route that keeps the **Refresh button** working, because the button needs
a process that can run the build. Two steps.

### Step 1 — run the server

```bash
npm start
```

That builds and serves. It prints a `Network` address like `http://172.20.10.2:4173`;
anyone on the same wifi can already open it. Good enough if all your users are in the
office.

To keep it running after you log out, register a Windows scheduled task set to *Run
whether user is logged on or not*:

- Program: `node`
- Arguments: `scripts\serve.mjs --port 4173`
- Start in: the repo folder
- Trigger: At startup

Give the machine a reserved IP so the address stays stable.

### Step 2 — turn on the password, then expose it

Set a shared password before the port is reachable from outside:

```bash
set BEMMP_PASSWORD=choose-something-long
npm run serve
```

The banner confirms `Password  on (user "cyrix")`. Change the username with `BEMMP_USER`.
In a scheduled task, set the variable in the task's environment rather than in a file, so
it is never committed.

Then publish the port with a Cloudflare Tunnel — free, gives HTTPS, and nothing needs to
be opened on your firewall:

```bash
cloudflared tunnel --url http://localhost:4173
```

That prints a `https://<random>.trycloudflare.com` URL you can send to users. It changes
every restart, which is fine for a trial.

For a permanent address on your own domain, create a named tunnel and point
`bemmp.cyrix.in` at it:

```bash
cloudflared tunnel login
cloudflared tunnel create bemmp
cloudflared tunnel route dns bemmp bemmp.cyrix.in
cloudflared tunnel run --url http://localhost:4173 bemmp
```

If you would rather not manage a password at all, put **Cloudflare Access** in front of the
tunnel instead and allow specific email addresses — users get a one-time code by email, and
the free tier covers 50 of them. Leave `BEMMP_PASSWORD` set as well; two gates cost
nothing.

**Do not expose the port with plain port-forwarding.** Basic auth sends the password on
every request, so it is only safe over the HTTPS the tunnel provides.

## Alternative: hosted static site with authentication

Use this if you do not want a machine of yours to be the server. You lose the Refresh
button — a static host has no process to run the build, so the button hides itself and you
republish by hand after each refresh.

Build locally, then upload `dist/` (tens of MB, mostly the `.bin` artifacts):

- **Azure Static Web Apps** — built-in authentication, easiest of the three.
- **Cloudflare Pages** + Cloudflare Access.
- **Netlify** — password protection is a paid feature.

Do not connect these to a Git repository: `BEMMP DATA/` is gitignored, so a CI build has no
workbooks to read and `npm run build:data` cannot run there. Upload `dist/` directly, which
also keeps the source workbooks off the platform.

Configure the cache carefully:

- Cache `/assets/` forever — Vite content-hashes those filenames.
- Never cache `index.html` or `/data/`. Both keep stable names across rebuilds. A cached
  `index.html` pins returning browsers to an old build whose hashed assets no longer
  exist, and the only cure is a hard reload on every client.
- Enable gzip/brotli for `.bin`. `tickets.bin` is packed Int32 data and compresses to
  roughly half its size; most servers leave `application/octet-stream` uncompressed.

`scripts/serve.mjs` already gets all of this right.

## GitHub Pages — with the upload build

A Pages site is public even from a private repository, and access control for Pages is
GitHub Enterprise Cloud only. Publishing the **server build** there would put engineer
names and phone numbers on the open internet.

The **upload build** sidesteps that entirely: it contains no ticket data, so there is
nothing to leak. Each user loads their own `TM-KL.xlsx` through the Data panel, the file is
parsed in their browser, and it never travels anywhere. What you publish is 235 KB of code.

```bash
npm run build:static     # vite build, then strips dist/data
```

Then publish `dist/` — either by pushing it to a `gh-pages` branch, or by committing it and
pointing Pages at `/docs`. Because the bundle has no data in it, daily refreshes never
touch the repository; users simply upload the day's export.

Vite emits absolute asset paths, so a project site served from
`https://<user>.github.io/<repo>/` needs the base path set:

```js
// vite.config.js
export default defineConfig({ base: '/<repo>/', /* … */ });
```

A user-or-organisation site (`https://<org>.github.io/`) needs no change.

### What the user does

1. Opens the link.
2. Sees the load screen, drags in `TM-KL.xlsx` (or clicks Upload on the contract).
3. Waits about 15 seconds for a Kerala export — a progress bar reports rows as they parse.
4. Uses the dashboard. The parsed data is cached in their browser, so the next visit opens
   straight to it.

Uploading a new export replaces the cached one, which is how daily updates work here — the
same act that refreshes the data on the server build.

### The trade-off

Every user needs a copy of the workbook, and each of them pays the ~15 second parse the
first time. If most of your users are in the office, the server build with its Refresh
button is a nicer experience; the upload build is the right answer when you need a link you
can send outside and cannot put a gateway in front of it.

## The assistant's OpenAI key

Never commit a key and never put one in the built bundle. Everything in `dist/` is
readable by anyone who opens the site, so a key shipped that way is published.

**On the office server** — put it in the environment and the browser never sees it:

```bash
set OPENAI_API_KEY=sk-...
npm run serve
```

The banner then reads `Assistant on (gpt-4o-mini, key held server-side)`. The page posts to
`/api/assistant` and the key stays in the Node process. Set it in the scheduled task's
environment, not in a file in the repo. `OPENAI_MODEL` overrides the model, which is pinned
server-side so a client cannot ask for an expensive one.

**On GitHub Pages** — Pages serves files and runs no code, so it cannot hold a secret
itself. Point the site at a tiny proxy that can. `serverless/cloudflare-worker.js` is one,
free on Cloudflare's plan:

```bash
npm install -g wrangler
wrangler init bemmp-assistant --no-deploy
# replace src/index.js with serverless/cloudflare-worker.js
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

Then build the site against it, and nobody is ever asked for a key:

```bash
VITE_ASSISTANT_URL=https://bemmp-assistant.<subdomain>.workers.dev npm run build:static
```

Set the same value as a repository variable named `VITE_ASSISTANT_URL` (Settings →
Secrets and variables → Actions → Variables) so the Pages workflow picks it up.

Edit `ALLOWED_ORIGINS` in the worker before deploying. Without that check the endpoint is
an open relay and anyone who finds the URL can spend the key.

**Why the key cannot simply be downloaded.** A common suggestion is to keep the key on the
server and have the page fetch it at startup. That is the same as publishing it: whatever
the page receives is visible in the browser's network tab, and the endpoint serving it can
be called directly by anyone. The key has to stay on the server and the *request* has to
travel to it — which is what both proxies here do. With either in place the key is entered
once by you, never by a user.

If a key is ever exposed, revoke it at **platform.openai.com/api-keys** and issue a new
one. Revoking is immediate; rotating later is not a substitute.

## Refreshing the data

The exports in `BEMMP DATA/` are overwritten by a SharePoint sync. Nothing picks that up on
its own — the dashboard reads a generated artifact, never the workbooks.

**From the dashboard**: the **Refresh** button in the header re-reads the workbooks, streams
its progress, and reloads the figures in place when it finishes — about 10 seconds for both
states, no page reload. It turns red with a dot when an export on disk is newer than the
dashboard, and hovering tells you when it was last built. Available on the tunnel route
only.

**From the command line**:

```bash
npm run refresh        # build:data + build
npm run build:data kl  # one state only
```

`build:data` prints open / penalty / unresolved / resolved / FTFR per state. If a number
moves unexpectedly, look at the export before publishing — those totals are the fastest
check that a refresh landed correctly.

**Unattended**: point a Windows scheduled task at `npm run build:data` each morning. Do not
schedule `npm run build` — only the data changes daily, and the running server picks up new
artifacts on the next page load without a restart.

## Adding a state

Add an entry to the `STATES` array in `scripts/build-data.mjs` — source filename, the
column letters for that export, its penalty SLA and barcode width — then run
`npm run build:data`. The switcher picks it up from `public/data/states.json`
automatically. No UI changes are needed.
