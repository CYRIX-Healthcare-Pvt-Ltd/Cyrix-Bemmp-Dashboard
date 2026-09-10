/**
 * The daily penalty meeting: the editable half of the open-call list.
 *
 * The split matters. Ticket facts — district, facility, equipment, down days,
 * penalty — come from the TM export and are rebuilt every time a new one lands,
 * so they are never written here. What Supabase holds is only what someone typed
 * in the meeting, keyed by ticket, and it survives the export being replaced.
 *
 * Which is the whole point of the reconcile: tomorrow's export decides which
 * tickets are still open, and yesterday's notes follow them across.
 */

import { supabase } from './supabase.js';

/**
 * Columns S..AO, in sheet order, with how each is entered.
 *
 * A width is a ceiling in pixels, and only where the kind is not a good
 * enough guess: a PI number and a current-status sentence are both text
 * and want very different room, so sizing by kind alone spends the
 * screen on the short one to be kind to the long one. Dates and numbers
 * have no entry because their kind already says everything.
 */
export const MEETING_FIELDS = [
  { key: 'penalty_type', label: 'Penalty type', kind: 'select', primary: true },
  { key: 'current_status', label: 'Current status as on date', kind: 'text', primary: true , width: 320 },
  { key: 'trc_given_date', label: 'TRC given', kind: 'date' },
  { key: 'trc_spare_received_date', label: 'TRC spare received', kind: 'date' },
  { key: 'standby_given_date', label: 'Standby given', kind: 'date' },
  { key: 'standby_days', label: 'Standby days', kind: 'number' },
  { key: 'pi_no', label: 'PI no', kind: 'text', width: 130 },
  { key: 'pi_date', label: 'PI date', kind: 'date' },
  { key: 'pi_tat', label: 'PI TAT', kind: 'number' },
  { key: 'pr_no', label: 'PR no', kind: 'text', width: 130 },
  { key: 'pr_date', label: 'PR date', kind: 'date' },
  { key: 'pr_conversion_days', label: 'PR conversion days', kind: 'number' },
  { key: 'pr_remark', label: 'PR purchase remark', kind: 'text', width: 260 },
  { key: 'po_no', label: 'PO no', kind: 'text', width: 130 },
  { key: 'po_date', label: 'PO date', kind: 'date' },
  { key: 'purchase_delay_days', label: 'Purchase delay days', kind: 'number' },
  { key: 'vendor_name', label: 'Vendor', kind: 'text', width: 200 },
  { key: 'payment_request_date', label: 'Payment requested', kind: 'date' },
  { key: 'payment_date', label: 'Payment date', kind: 'date' },
  { key: 'spare_edd', label: 'Spare EDD', kind: 'date' },
  { key: 'po_remark', label: 'PO purchase remark', kind: 'text', width: 260 },
  { key: 'payment_issue', label: 'Pending on payment?', kind: 'text', width: 190 },
  { key: 'not_in_scope_reason', label: 'Reason if out of scope', kind: 'text', width: 300 },
];

/**
 * The two fields that carry the meeting. In the source workbook penalty type is
 * filled on 99% of rows and current status on 27%; nothing else clears 3%. So
 * those two are columns in the grid and the remaining twenty-one live behind a
 * per-row expander rather than in a wall of empty cells.
 */
export const PRIMARY_FIELDS = MEETING_FIELDS.filter((f) => f.primary);
export const DETAIL_FIELDS = MEETING_FIELDS.filter((f) => !f.primary);

const SELECT = ['state', 'ticket', 'closed_on', 'updated_at', 'legacy_values']
  .concat(MEETING_FIELDS.map((f) => f.key))
  .join(',');

/**
 * Rows per request.
 *
 * PostgREST's own ceiling on a returned page, and a comfortable size for a
 * batch going the other way. It replaces a 400-ticket chunk that existed to
 * keep a `ticket=in.(...)` URL under the length limit — there is no such
 * list any more, so the limit that mattered is the row count.
 */
const PAGE = 1000;

/**
 * Notes for the tickets currently on screen, keyed by ticket.
 *
 * Fetched as the state's own pages, in parallel, and matched against the
 * tickets afterwards.
 *
 * It used to name the tickets: four hundred at a time in a `ticket=in.(...)`
 * list, because a longer URL is rejected. That was three round trips when the
 * tracker held the nine hundred open calls. The tracker holds every
 * unresolved call now — eight thousand three hundred — which made it
 * twenty-one round trips taken one after another, measured at 5.9 seconds
 * before a single row could be drawn.
 *
 * Asking for the state instead is fewer requests, because a page holds a
 * thousand rows rather than four hundred, and they can all be in flight at
 * once because none of them depends on the one before. Measured at 0.99
 * seconds for the same result.
 *
 * It does fetch notes for tickets the tracker is not showing — calls resolved
 * since the workbook was written. That is 681 rows in 8,976, and paying 8%
 * more data to spend a fifth of the time is not a close decision.
 *
 * `onStep` reports each completed request so the caller can show real
 * progress rather than a spinner that means nothing.
 */
export async function loadNotes(state, tickets, onStep) {
  if (!supabase || !tickets.length) return new Map();

  // The page count has to be known before the pages can be asked for
  // together, and `head` makes that a count and no rows.
  const { count, error: countError } = await supabase
    .from('meeting_note')
    .select('ticket', { count: 'exact', head: true })
    .eq('state', state);
  if (countError) throw countError;

  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  let done = 0;
  onStep?.(0, pages);

  const fetched = await Promise.all(Array.from({ length: pages }, async (_, i) => {
    const { data, error } = await supabase
      .from('meeting_note')
      .select(SELECT)
      .eq('state', state)
      // Ordered because a range without one is not a stable window: two
      // pages could return the same row and never return another.
      .order('ticket')
      .range(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    done += 1;
    onStep?.(done, pages);
    return data;
  }));

  const wanted = new Set(tickets);
  const out = new Map();
  for (const rows of fetched) {
    for (const row of rows) if (wanted.has(row.ticket)) out.set(row.ticket, row);
  }
  return out;
}

/**
 * Writes one field of one ticket.
 *
 * A field at a time rather than a whole row: several people edit this grid at
 * once during the meeting, and sending the whole row would have each save
 * overwrite whatever a colleague changed in a different column since the page
 * loaded. The audit trigger records the before and after either way.
 */
export async function saveField(state, ticket, key, value) {
  if (!supabase) throw new Error('Not connected.');
  const { data, error } = await supabase
    .from('meeting_note')
    .update({ [key]: value === '' ? null : value })
    .eq('state', state)
    .eq('ticket', ticket)
    .select(SELECT);
  if (error) throw error;
  // Row-level security answers a refused write with success and no rows, so an
  // empty result is the signal that this account may not edit — not an error.
  if (!data.length) throw new Error('You do not have permission to edit this row.');
  return data[0];
}

/**
 * Creates note rows for tickets that have none, so a first edit has somewhere to
 * land. Runs under the signed-in user, so it is subject to the same policies.
 *
 * Together rather than one after another, for the same reason as loadNotes:
 * twenty-one sequential upserts of four hundred rows measured 5.3 seconds
 * against 0.56 for nine of a thousand run at once. The batches hold disjoint
 * tickets and conflicts are ignored rather than updated, so no two of them
 * are ever contending for the same row.
 */
export async function ensureRows(state, tickets, onStep) {
  if (!supabase || !tickets.length) return;
  const batches = [];
  for (let i = 0; i < tickets.length; i += PAGE) {
    batches.push(tickets.slice(i, i + PAGE).map((ticket) => ({ state, ticket })));
  }
  let done = 0;
  onStep?.(0, batches.length);
  await Promise.all(batches.map(async (rows) => {
    const { error } = await supabase
      .from('meeting_note')
      .upsert(rows, { onConflict: 'state,ticket', ignoreDuplicates: true });
    if (error) throw error;
    done += 1;
    onStep?.(done, batches.length);
  }));
}

/**
 * Every recorded change to one ticket, newest first.
 *
 * Goes through an RPC because `changed_by` is a uuid and `profile` is readable
 * only for your own row, so the browser cannot resolve a colleague's id to a
 * name. The function does that and hands back nothing else.
 *
 * Loaded when the log is opened rather than with the grid: the tracker carries
 * the whole open backlog, and nine hundred tickets' history is not something to
 * fetch in order to draw a column of buttons.
 */
export async function loadLog(state, ticket) {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('meeting_log', {
    p_state: state,
    p_ticket: ticket,
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * Reconciles yesterday against today.
 *
 * Anything still open keeps its notes and has `last_seen` moved forward.
 * Anything that has dropped off the open list is stamped `closed_on` rather than
 * deleted — a call that reopens should not come back blank, and the meeting
 * wants a record of what was said about it. A hard purge is a separate decision.
 */
export async function reconcileOpen(state, openTickets) {
  if (!supabase) return { reopened: 0, closed: 0 };
  const { data, error } = await supabase.rpc('reconcile_open_calls', {
    p_state: state,
    p_tickets: openTickets,
  });
  if (error) throw error;
  return data?.[0] ?? { reopened: 0, closed: 0 };
}

/* ------------------------------------------------------------------ *
 * The four columns the workbook worked out rather than collected.
 * ------------------------------------------------------------------ */

/**
 * Days between two dates, or null if either is missing or unreadable.
 *
 * Whole days on the calendar, not elapsed time: both sides are pinned to
 * midnight before subtracting, so a PO raised at 18:00 and a PR at 09:00
 * the next morning is one day rather than nought.
 */
function daysBetween(later, earlier) {
  const a = dayStart(later);
  const b = dayStart(earlier);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * A stored date, pinned to midnight — or null.
 *
 * Deliberately strict. This fell back to `new Date(value)` for anything
 * that was not obviously ISO, and that constructor will take almost any
 * string and return some date: "PI-4471" came back as a day in the fifth
 * century and turned a purchase delay into -892,770 days. A PO number in
 * a date column is the kind of thing that is already in the source
 * sheet, so it has to read as "nothing here" rather than as a number
 * somebody might act on.
 *
 * Everything real arrives from Postgres as YYYY-MM-DD, with or without a
 * time after it, so nothing legitimate needs the leniency.
 */
function dayStart(value) {
  if (value == null || value === '') return null;
  // An epoch, which is how `now` arrives and how a caller would pass a
  // fixed reference day. Numbers are unambiguous; strings are not, which
  // is the whole point of the rest of this function.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 2026-13-40 parses as a shape and is not a day.
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

/** Today, as a date rather than a moment. */
const today = () => {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * What each calculated column comes to, given everything else on the row.
 *
 * These were four formulas in the workbook and four columns people
 * retyped into it. Three of them count from today, so a stored answer is
 * wrong by the next morning — they are worked out when they are shown
 * and never written down, which is also why they cannot be edited.
 *
 * PI TAT is a number of days, like the other three. The workbook's
 * formula reads as though it gives a verdict instead, and across eight
 * and a half thousand rows it never once did: the dates there are text,
 * so the subtraction always errored and the fallback always won. The
 * column people actually read has therefore always been a day count,
 * and that is what it stays — once there is a PR it is how long the PI
 * took, and until then it is how long it has been waiting.
 */
export const COMPUTED = {
  standby_days: (n, now) => daysBetween(now, n.standby_given_date),

  pi_tat: (n, now) => {
    const taken = daysBetween(n.pr_date, n.pi_date);
    return taken !== null ? taken : daysBetween(now, n.pi_date);
  },

  pr_conversion_days: (n) => daysBetween(n.po_date, n.pr_date),

  purchase_delay_days: (n, now) => daysBetween(now, n.po_date),
};

/** True for the columns nobody types into. */
export const isComputed = (key) => Object.hasOwn(COMPUTED, key);

/**
 * One calculated column for one row. Null where the dates it needs are
 * not there yet, which is most of them for most of the year.
 */
export function computeField(key, note, now = today()) {
  const fn = COMPUTED[key];
  if (!fn) return null;
  return fn(note ?? {}, now);
}

/* ------------------------------------------------------------------ *
 * Column filters.
 * ------------------------------------------------------------------ */

/**
 * What "(blank)" is, and how it stays apart from a real value.
 *
 * Filtering on nothing is half the reason to filter these columns —
 * "every call with no PI raised" is the agenda. It needs a token no cell
 * could produce, so a vendor literally named "(blank)" still filters as
 * itself. A NUL is the one character a spreadsheet cannot carry.
 */
export const BLANK = ' blank';
export const BLANK_LABEL = '(blank)';

/** A cell as the filter sees it: a string, or the blank token. */
export const asChoice = (v) => (v == null || v === '' ? BLANK : String(v));

/**
 * Each column's list of values, narrowed by the OTHER columns' filters.
 *
 * Filtering to a district and then opening Facility should offer the
 * facilities in that district rather than all four hundred in the state,
 * or the second filter is mostly options that return nothing.
 *
 * Every filter except the column's own, and that exception is the part
 * that is easy to get wrong: narrowing a list by its own filter leaves
 * it showing only what is already ticked, so there is no way to add a
 * second district or to see what you have excluded.
 */
export function buildChoices(rows, columns, activeFilters) {
  const out = {};
  for (const c of columns) {
    const others = activeFilters.filter(([key]) => key !== c.key);
    const base = others.length
      ? rows.filter((r) => others.every(([key, vals]) => vals.includes(asChoice(r[key]))))
      : rows;

    const counts = new Map();
    for (const r of base) {
      const v = asChoice(r[c.key]);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const numeric = c.type === 'num';
    out[c.key] = [...counts].sort((a, b) => {
      // Blank last. It is the absence of a value rather than the smallest
      // one, and sorting it among the numbers reads as a nought that is
      // not there.
      if (a[0] === BLANK) return 1;
      if (b[0] === BLANK) return -1;
      return numeric ? Number(a[0]) - Number(b[0]) : a[0].localeCompare(b[0]);
    });
  }
  return out;
}

/** The rows that pass every active filter. */
export const applyFilters = (rows, activeFilters) => (
  activeFilters.length
    ? rows.filter((r) => activeFilters.every(
      ([key, vals]) => vals.includes(asChoice(r[key])),
    ))
    : rows
);

/**
 * The rows a view is holding, in the order it chose them, with today's
 * values.
 *
 * Filtering PO no to blanks and then typing a PO number made that row
 * vanish the moment it saved — before anybody could reach PO date in
 * the same row. The filter was right that the row no longer matched; it
 * was wrong to act on it mid-entry. People took the vanishing row for a
 * failed save and typed the same PO into the next row, and the next: one
 * PO number landed on three tickets inside a minute that way.
 *
 * So the view decides membership and order when it is applied, and this
 * reads that decision back against the current rows. Edited values show;
 * the row stays put. A key whose row has gone entirely — a call that
 * closed on reload — is simply dropped.
 *
 * Deliberately handed every row rather than the searched ones: a row
 * found by searching for its PO number must not vanish because the PO
 * number was the thing being corrected.
 */
export function holdRows(keys, rows, keyOf = (r) => r.ticket) {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const out = [];
  for (const k of keys) {
    const r = byKey.get(k);
    if (r) out.push(r);
  }
  return out;
}

/* ===================================================================== *
 * The tracker's columns.
 *
 * Here rather than in MeetingTab because they are data, and because a
 * test that cannot import them is a test that cannot check them: Node
 * reads .js and not .jsx, and the one bug this arrangement is meant to
 * prevent — a heading with no cell under it — shipped while these lived
 * next to the markup that was supposed to match them.
 * ===================================================================== */

/** Column definitions for the read-only half, so the header and the body cannot
 *  drift apart when one of them is conditional. */
/**
 * The meeting's own fields, as columns.
 *
 * Reversed from the note below: two of these used to be live inputs in
 * the grid and were pulled out because a dropdown and a text box on nine
 * hundred rows is a lot to scroll past, and because they pushed the
 * columns that identify a row off the side. The people who fill these in
 * asked for all twenty-three back, and the two objections are answered
 * rather than ignored — the ticket column is pinned so the row is always
 * identified, full screen gives the width, filters cut what you scroll
 * past, and a cell is text until you click it, so nine hundred rows are
 * nine hundred spans rather than twenty thousand live inputs.
 *
 * The low fill rate was probably the cause and not the reason: nothing
 * below the first two clears 3%, and reaching them cost a click per row.
 */
const KIND_WIDTH = { date: 128, number: 108, select: 168, text: 190 };

/** Default width per entry column, by key — the same value its heading uses. */
export const ENTRY_WIDTH = {};

const ENTRY_COLUMNS = MEETING_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  type: f.kind === 'number' ? 'num' : 'text',
  align: f.kind === 'number' ? 'num' : undefined,
  w: f.width ?? KIND_WIDTH[f.kind] ?? 190,
  /** Present on exactly the columns that are editable. */
  entry: f,
}));

for (const c of ENTRY_COLUMNS) ENTRY_WIDTH[c.key] = c.w;

export function exportColumns(hasZone) {
  return [
    { key: 'ticket', label: 'Ticket', type: 'text', w: 118 },
    /* "Down days", which is what the business calls it. On this tab it is exact:
       the tracker is open calls only, so days since logging is days the
       equipment has been down. */
    { key: 'age', label: 'Down Days', type: 'num', align: 'num', w: 76 },
    ...(hasZone ? [{ key: 'zone', label: 'Zone', type: 'text', w: 96 }] : []),
    { key: 'district', label: 'District', type: 'text', w: 120 },
    { key: 'facility', label: 'Facility', type: 'text', w: 190 },
    { key: 'equipment', label: 'Equipment', type: 'text', w: 180 },
    /* The rest of what the TM export knows about the machine and who has
       it. Asked for by the meeting, which reads these off the workbook
       today and had to keep both open side by side to do it. */
    { key: 'barcode', label: 'Barcode', type: 'text', w: 120 },
    { key: 'manufacturer', label: 'Manufacturer', type: 'text', w: 150 },
    { key: 'model', label: 'Model', type: 'text', w: 140 },
    { key: 'logged', label: 'Logged', type: 'text', w: 118 },
    /* When the machine went in. Blank for anything installed before the
       contract, and blank for Andhra, whose export lays its columns out
       differently and was not to hand to map against. */
    { key: 'installed', label: 'Installed', type: 'text', w: 118 },
    { key: 'status', label: 'Status', type: 'text', w: 140 },
    { key: 'assigned', label: 'Assigned', type: 'text', w: 190 },
    /* Why a call is parked. The reason the backlog is what it is, and
       until now the reason it was hidden. */
    { key: 'remark', label: 'Ticket remark', type: 'text', w: 170 },
    /*
     * Two money columns, because they answer the two questions the meeting
     * actually asks. The rate is what this ticket costs per day it stays open;
     * `accrued` is what it has cost so far. A ₹50/d ticket open since October
     * has run up more than a ₹1,000/d one logged on Tuesday, and ranking on the
     * rate alone hides exactly that — which is the reason the column is here.
     */
    /* The heading carries the unit, so the cells do not repeat it. A column of
       "₹50/d" spends its width saying "per day" on every row. */
    { key: 'rate', label: 'Per day penalty', type: 'num', align: 'num', w: 110 },
    { key: 'accrued', label: 'Penalty', type: 'num', align: 'num', w: 110 },
    ...ENTRY_COLUMNS,
  ];
}
