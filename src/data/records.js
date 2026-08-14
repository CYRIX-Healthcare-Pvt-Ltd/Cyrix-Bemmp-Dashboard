/**
 * The two Postgres tables Cyra can read: the meeting's notes, and the account
 * audit trail.
 *
 * Everything else she answers comes from `tickets.bin` in this browser. These
 * two genuinely live in the database, are small, and are relational — which is
 * why they get a query tool rather than a measure.
 *
 * Three properties carry over from the ticket side unchanged, and they are the
 * whole answer to "does this data go anywhere":
 *
 *  1. **The model never sees a row.** It returns a spec — which table, which
 *     ticket, which field — and this module runs it. The rows come back to the
 *     browser and the sentence is composed here, exactly as `describeResult`
 *     does for figures. Nothing fetched is ever sent to OpenAI.
 *
 *  2. **Row-level security decides what is visible, not this file.** Every query
 *     goes through the browser's own Supabase client carrying the signed-in
 *     user's session, so `meeting_note_read` (`in_scope(state)`) and
 *     `account_audit_read` (`is_admin()`) apply exactly as they do everywhere
 *     else. A Kerala coordinator asking about an Andhra ticket gets nothing; a
 *     coordinator asking who reset a password gets nothing. There is no new
 *     trust boundary here and deliberately no service key — routing this through
 *     `api/` would mean re-implementing scope in JavaScript that RLS already
 *     enforces in the database.
 *
 *  3. **Answers are marked `sensitive`.** Purchasing remarks are free text and
 *     could say anything somebody typed. `translateSentence` is the one path
 *     that would put a composed sentence in front of the model; it is not wired
 *     up today, and this flag is what stops it being wired up over this.
 */

import { supabase } from './supabase.js';
import { ticketLabel } from './store.js';

/* ------------------------------------------------------------------ tool -- */

/**
 * Fields worth asking about by name.
 *
 * A deliberately short list rather than every column: these are the ones the
 * meeting actually chases, and a shorter enum is one the model picks correctly.
 * `label` is what the answer calls them — the database's `pr_no` means nothing
 * read aloud.
 */
export const NOTE_FIELDS = {
  status: { col: 'current_status', label: 'current status' },
  penaltyType: { col: 'penalty_type', label: 'penalty type' },
  trc: { col: 'trc_given_date', label: 'TRC given date' },
  spare: { col: 'trc_spare_received_date', label: 'spare received date' },
  standby: { col: 'standby_given_date', label: 'standby given date' },
  quotation: { col: 'pi_no', label: 'quotation (PI) number' },
  requisition: { col: 'pr_no', label: 'purchase requisition (PR) number' },
  order: { col: 'po_no', label: 'purchase order (PO) number' },
  vendor: { col: 'vendor_name', label: 'vendor' },
  payment: { col: 'payment_date', label: 'payment date' },
  eta: { col: 'spare_edd', label: 'expected spare delivery' },
  remark: { col: 'po_remark', label: 'PO remark' },
  issue: { col: 'payment_issue', label: 'payment issue' },
};

const NOTE_COLS = Object.values(NOTE_FIELDS).map((f) => f.col);

export const RECORD_TOOL = {
  type: 'function',
  function: {
    name: 'look_up_record',
    description:
      'Look up what the daily meeting recorded against a ticket, or the account '
      + 'audit trail. Use this for "what did we decide on ticket 285716", "which '
      + 'tickets are waiting on a PO", "who reset KLCoord\'s password". NOT for '
      + 'counts, rankings or money — those are query_dashboard.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['meeting', 'accounts'],
          description: 'meeting = what was recorded against tickets. '
            + 'accounts = who created, disabled or reset a login.',
        },
        ticket: {
          type: 'string',
          description: 'One ticket number, when the question names one.',
        },
        field: {
          type: 'string',
          enum: Object.keys(NOTE_FIELDS),
          description: 'Which meeting field the question is about.',
        },
        awaiting: {
          type: 'boolean',
          description: 'true for "still waiting on" / "not yet raised" — tickets '
            + 'where that field is still empty. false or absent lists the ones that have it.',
        },
        who: {
          type: 'string',
          description: 'An employee code, for account questions.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['source'],
    },
  },
};

/* --------------------------------------------------------------- running -- */

const shown = (v) => (v == null || v === '' ? null : String(v));

/** One ticket's note, as `field: value` pairs that actually have a value. */
function pairsOf(row) {
  return Object.entries(NOTE_FIELDS)
    .map(([, f]) => [f.label, shown(row[f.col])])
    .filter(([, v]) => v != null);
}

/**
 * Runs a record spec.
 *
 * Returns `{ sentence, rows, sensitive }`. The caller renders it; nothing here
 * goes back to the model.
 */
export async function runRecordQuery(ds, spec, profile) {
  if (!supabase) throw new Error('Not connected to the database.');
  const limit = Math.min(50, Math.max(1, Number(spec.limit) || 10));

  if (spec.source === 'accounts') return accountQuery(spec, limit, profile);
  return meetingQuery(ds, spec, limit);
}

async function meetingQuery(ds, spec, limit) {
  const state = ds.meta.id;

  if (spec.ticket) {
    const ticket = String(spec.ticket).trim();
    const { data, error } = await supabase
      .from('meeting_note')
      .select(['ticket', ...NOTE_COLS, 'updated_at'].join(','))
      .eq('state', state)
      .eq('ticket', ticket)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Nothing back can mean "no note" or "not your contract". Both are the same
    // answer to the person asking, and distinguishing them would leak which
    // tickets exist outside their scope.
    if (!data) {
      return {
        sentence: `Nothing has been recorded against ticket ${ticket} on `
          + `${ds.meta.name}, or it is outside the contracts you can see.`,
        rows: [], sensitive: true,
      };
    }

    const pairs = pairsOf(data);
    return {
      sentence: pairs.length
        ? `Ticket ${ticket} — ${pairs.map(([k, v]) => `${k}: ${v}`).join('; ')}.`
        : `Ticket ${ticket} has a meeting entry but every field is still blank.`,
      rows: pairs.map(([k, v]) => ({ label: k, value: v })),
      sensitive: true,
    };
  }

  const field = NOTE_FIELDS[spec.field];
  if (!field) {
    throw new Error('Name a ticket, or say which field you mean — PO, quotation, vendor, TRC.');
  }

  let q = supabase
    .from('meeting_note')
    .select(`ticket, ${field.col}, updated_at`)
    .eq('state', state)
    .is('closed_on', null)
    .limit(limit);
  q = spec.awaiting ? q.is(field.col, null) : q.not(field.col, 'is', null);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const verb = spec.awaiting ? 'still have no' : 'have a';
  if (!data?.length) {
    return {
      sentence: `No open tickets ${verb} ${field.label} recorded.`,
      rows: [], sensitive: true,
    };
  }
  return {
    sentence: `${data.length}${data.length === limit ? '+' : ''} open ticket`
      + `${data.length === 1 ? '' : 's'} ${verb} ${field.label}.`,
    rows: data.map((r) => ({
      label: `Ticket ${r.ticket}`,
      value: shown(r[field.col]) ?? '—',
    })),
    sensitive: true,
  };
}

/**
 * The account trail.
 *
 * Read straight from `account_audit`, whose select policy is `is_admin()`. A
 * non-admin therefore gets an empty result from the database itself rather than
 * from a check written here — which is the point: the rule lives in one place
 * and this cannot get it wrong.
 */
async function accountQuery(spec, limit, profile) {
  let q = supabase
    .from('account_audit')
    .select('at, action, actor_code, target_code, detail')
    .order('at', { ascending: false })
    .limit(limit);
  if (spec.who) q = q.eq('target_code', String(spec.who).trim());

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  if (!data?.length) {
    return {
      sentence: profile?.role === 'admin'
        ? 'Nothing is recorded in the account trail for that.'
        : 'Account history is visible to administrators only.',
      rows: [], sensitive: true,
    };
  }

  const ACTION = {
    create: 'created', update: 'changed', reset: 'had its password reset',
    disable: 'was disabled', enable: 'was re-enabled',
  };
  return {
    sentence: `${data.length} account change${data.length === 1 ? '' : 's'}, newest first.`,
    rows: data.map((r) => ({
      label: new Date(r.at).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      }),
      value: `${r.target_code} ${ACTION[r.action] ?? r.action} by ${r.actor_code}`,
    })),
    sensitive: true,
  };
}

/** Ticket numbers in a question, so "285716" can be matched without the model. */
export function ticketInQuestion(text) {
  const m = /\b((?:AP)?\d{4,})\b/i.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export { ticketLabel };
