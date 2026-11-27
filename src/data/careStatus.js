/*
 * Care 360's Ticket Status per call (the user, 27 Nov): what the tracker holds (meeting_note.ticket_status, 0094),
 * else what their Ticket Master carries in "Ticket Status - Pending/Completed". Read by the dashboard's Ticket Status
 * filter and by the Report's Pending split.
 */
import { supabase } from './supabase.js';
import { ticketLabel } from './store.js';
import { CARE_STATUSES, CARE_STATUS_HEADING } from './meeting.js';

export const NOT_SET = 'Not set';
/** The Pending split's order (the user, 27 Nov). */
export const PENDING_ORDER = ['Under Observation', 'Customer', 'Revive Lab', 'Cyrix', 'Purchase'];
export const STATUS_CHOICES = [...CARE_STATUSES, NOT_SET];

/** ticket → status for every call the tracker has a status for; paged, since a state passes 1,000 rows. */
export async function loadCareStatuses(state) {
  const out = new Map();
  if (!supabase) return out;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('meeting_note').select('ticket,ticket_status')
      .eq('state', state).not('ticket_status', 'is', null).order('ticket').range(from, from + 999);
    if (error) throw error;
    for (const r of data) out.set(r.ticket, r.ticket_status);
    if (data.length < 1000) break;
  }
  return out;
}

const loose = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** One status per dataset row: the tracker's, else the export's own column, else NOT_SET. */
export function statusByRow(ds, notes) {
  const raw = ds.meta.raw;
  const at = (raw?.headings ?? []).findIndex((h) => loose(h) === loose(CARE_STATUS_HEADING));
  const out = new Array(ds.rows);
  for (let i = 0; i < ds.rows; i++) {
    let s = notes?.get(ticketLabel(ds, i));
    if (!s && at >= 0) {
      const v = String(raw.rows[i]?.[at] ?? '').trim().toLowerCase();
      s = CARE_STATUSES.find((o) => o.toLowerCase() === v);
    }
    out[i] = s || NOT_SET;
  }
  return out;
}
