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

/** Columns S..AO, in sheet order, with how each is entered. */
export const MEETING_FIELDS = [
  { key: 'penalty_type', label: 'Penalty type', kind: 'select', primary: true },
  { key: 'current_status', label: 'Current status as on date', kind: 'text', primary: true },
  { key: 'trc_given_date', label: 'TRC given', kind: 'date' },
  { key: 'trc_spare_received_date', label: 'TRC spare received', kind: 'date' },
  { key: 'standby_given_date', label: 'Standby given', kind: 'date' },
  { key: 'standby_days', label: 'Standby days', kind: 'number' },
  { key: 'pi_no', label: 'PI no', kind: 'text' },
  { key: 'pi_date', label: 'PI date', kind: 'date' },
  { key: 'pi_tat', label: 'PI TAT', kind: 'number' },
  { key: 'pr_no', label: 'PR no', kind: 'text' },
  { key: 'pr_date', label: 'PR date', kind: 'date' },
  { key: 'pr_conversion_days', label: 'PR conversion days', kind: 'number' },
  { key: 'pr_remark', label: 'PR purchase remark', kind: 'text' },
  { key: 'po_no', label: 'PO no', kind: 'text' },
  { key: 'po_date', label: 'PO date', kind: 'date' },
  { key: 'purchase_delay_days', label: 'Purchase delay days', kind: 'number' },
  { key: 'vendor_name', label: 'Vendor', kind: 'text' },
  { key: 'payment_request_date', label: 'Payment requested', kind: 'date' },
  { key: 'payment_date', label: 'Payment date', kind: 'date' },
  { key: 'spare_edd', label: 'Spare EDD', kind: 'date' },
  { key: 'po_remark', label: 'PO purchase remark', kind: 'text' },
  { key: 'payment_issue', label: 'Pending on payment?', kind: 'text' },
  { key: 'not_in_scope_reason', label: 'Reason if out of scope', kind: 'text' },
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

/** PostgREST caps a URL's length, so tickets are asked for in batches. */
const IN_CHUNK = 400;

/**
 * Notes for the tickets currently on screen, keyed by ticket.
 *
 * Asked for by ticket rather than "everything for this state" because the state
 * accumulates rows for every ticket ever seen, while the meeting only ever shows
 * what is open now.
 */
export async function loadNotes(state, tickets) {
  if (!supabase || !tickets.length) return new Map();
  const out = new Map();
  for (let i = 0; i < tickets.length; i += IN_CHUNK) {
    const batch = tickets.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from('meeting_note')
      .select(SELECT)
      .eq('state', state)
      .in('ticket', batch);
    if (error) throw error;
    for (const row of data) out.set(row.ticket, row);
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
 */
export async function ensureRows(state, tickets) {
  if (!supabase || !tickets.length) return;
  const rows = tickets.map((ticket) => ({ state, ticket }));
  for (let i = 0; i < rows.length; i += IN_CHUNK) {
    const { error } = await supabase
      .from('meeting_note')
      .upsert(rows.slice(i, i + IN_CHUNK), { onConflict: 'state,ticket', ignoreDuplicates: true });
    if (error) throw error;
  }
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
