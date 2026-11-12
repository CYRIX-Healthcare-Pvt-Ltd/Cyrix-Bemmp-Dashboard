/**
 * Quotation tracker — a project inside BEMMP (supabase/migrations/0015_quotation_tracker.sql).
 *
 * The spare-quotation workflow from the user's Google Apps Script, moved into
 * our database (the user, 11 Nov 2026): Engineer → Team Lead → Coordinator →
 * Purchase rates → PV → Coordinator PR → Purchase PO and dispatch → receipt,
 * with faulty returns, stock (STK) requests and a stock register. Every step
 * waits for an Accept, so who accepted late shows.
 */
import { supabase } from './supabase.js';
import { writeBook, saveBlob } from './xlsx.js';

export const QT_PROJECT = { id: 'qt', short: 'QT', name: 'Quotation tracker' };

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const loadQtMe = () => (supabase ? rpc('qt_me') : Promise.resolve(null));
export const loadList = (from, to) => rpc('qt_list', { p_from: from || null, p_to: to || null });
export const loadOne = (id) => rpc('qt_one', { p_id: id });
export const loadFacilities = () => rpc('qt_facility_list');
export const loadEquipmentAt = (facility) => rpc('qt_equipment_at', { p_facility: facility });
export const loadPeople = () => rpc('qt_people_list');
export const loadTargets = () => rpc('qt_targets');
export const loadEvents = (from, to) => rpc('qt_events_in', { p_from: from || null, p_to: to || null });

export const raise = (p) => rpc('qt_raise', { p });
export const raiseStock = (p) => rpc('qt_raise_stock', { p });
export const accept = (ids) => rpc('qt_accept', { p_ids: ids });
export const tlApprove = (ids, p = null) => rpc('qt_tl_approve', { p_ids: ids, p });
export const editOwn = (id, p) => rpc('qt_edit_own', { p_id: id, p });
export const reopen = (id, note) => rpc('qt_reopen', { p_id: id, p_note: note });
export const addNote = (id, note) => rpc('qt_note', { p_id: id, p_note: note });
export const consume = (id, qty, note) => rpc('qt_consume', { p_id: id, p_qty: qty, p_note: note });
export const resume = (id) => rpc('qt_resume', { p_id: id });
export const saveFacility = (p) => rpc('qt_save_facility', { p });
export const savePerson = (p) => rpc('qt_save_person', { p });
export const removePerson = (id) => rpc('qt_remove_person', { p_employee: id });
export const saveTargets = (p) => rpc('qt_save_targets', { p });
export const findPerson = (q) => rpc('qt_find_person', { p_q: q });

/** Each step's own action, by the step's name. */
const STEP_FN = {
  coord_initial: 'qt_coord_initial', tl_clarify: 'qt_tl_reply', purchase_rates: 'qt_purchase_rates', pv: 'qt_pv',
  coord_quote: 'qt_coord_quote', eng_quote: 'qt_eng_quote', coord_pr: 'qt_coord_pr', purchase_dispatch: 'qt_purchase_dispatch', coord_decide: 'qt_coord_decide',
  receipt: 'qt_receipt_with_signed', observation: 'qt_receipt_with_signed', purchase_faulty: 'qt_purchase_faulty',
  return_dispatch: 'qt_return_dispatch', purchase_replacement: 'qt_replacement', eng_fix: 'qt_eng_fix',
};
export const tlDecline = (id, p) => rpc('qt_tl_decline', { p_id: id, p });
export const act = (step, id, p) => rpc(STEP_FN[step], { p_id: id, p });

/* ------------------------------------------------------------ words -- */

/** Each step in plain words, who works it, and its colour. */
export const STEPS = {
  tl_review: { label: 'Sent to Team Lead', who: 'Team Lead', tone: 'yellow' },
  eng_fix: { label: 'Sent back to engineer to correct', who: 'Engineer', tone: 'orange' },
  tl_clarify: { label: 'Question sent to Team Lead', who: 'Team Lead', tone: 'amber' },
  coord_initial: { label: 'Sent to Coordinator', who: 'Coordinator', tone: 'violet' },
  purchase_rates: { label: 'Sent to Purchase for rates', who: 'Purchase', tone: 'teal' },
  pv: { label: 'Sent to PV', who: 'PV', tone: 'pink' },
  coord_quote: { label: 'Sent to Coordinator for quotation', who: 'Coordinator', tone: 'violet' },
  eng_quote: { label: 'Quotation submitted', who: 'Engineer', tone: 'orange' },
  coord_pr: { label: 'Quotation approved, PR to raise', who: 'Coordinator', tone: 'violet' },
  on_hold: { label: 'On hold with Coordinator', who: 'Coordinator', tone: 'grey' },
  purchase_dispatch: { label: 'PO requested from Purchase', who: 'Purchase', tone: 'teal' },
  coord_decide: { label: 'Hold or cancel asked of Coordinator', who: 'Coordinator', tone: 'amber' },
  on_hold_dispatch: { label: 'On hold with Coordinator', who: 'Coordinator', tone: 'grey' },
  receipt: { label: 'Dispatched to engineer', who: 'Engineer', tone: 'orange' },
  observation: { label: 'Under observation with engineer', who: 'Engineer', tone: 'amber' },
  purchase_faulty: { label: 'Faulty reported to Purchase', who: 'Purchase', tone: 'red' },
  return_dispatch: { label: 'Faulty spare to send back', who: 'Engineer', tone: 'red' },
  purchase_replacement: { label: 'Faulty sent back to Purchase', who: 'Purchase', tone: 'teal' },
  completed: { label: 'Completed', tone: 'green' },
  quotation_only: { label: 'Quotation only', tone: 'green' },
  moved_to_stock: { label: 'Moved to stock', tone: 'grey' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  closed: { label: 'Closed', tone: 'red' },
  rejected: { label: 'Rejected', tone: 'red' },
};
export const stepOf = (s) => STEPS[s] ?? { label: s, tone: 'grey' };
/** Each stage as the work done in it, for TAT (the user, 11 Nov: the doer's words, not "sent to"). */
export const WORK = {
  tl_review: 'Team Lead approval', eng_fix: 'Correcting the request', tl_clarify: 'Answering a question', coord_initial: 'Coordinator check',
  purchase_rates: 'Giving rates', pv: 'Price verification', coord_quote: 'Sending the quotation', eng_quote: 'Customer approval',
  coord_pr: 'Raising the PR', purchase_dispatch: 'PO and dispatch', coord_decide: 'Hold or cancel decision', receipt: 'Confirming receipt',
  observation: 'Under observation', purchase_faulty: 'Faulty spare', return_dispatch: 'Sending the faulty back', purchase_replacement: 'Sending a replacement',
};
export const workOf = (s) => WORK[s] ?? stepOf(s).label;
/**
 * The status in words, by role (the user, 11 Nov): sent to someone, then that someone at work once accepted.
 * [before Accept, after Accept]; steps with no Accept have one wording.
 */
const STATUS = {
  tl_review: ['Sent to Team Lead', 'Team Lead reviewing'],
  eng_fix: ['Sent back to engineer to correct'],
  tl_clarify: ['Question sent to Team Lead', 'Team Lead answering'],
  coord_initial: ['Sent to Coordinator', 'Coordinator checking'],
  purchase_rates: ['Sent to Purchase for rates', 'Purchase giving rates'],
  pv: ['Sent to PV', 'PV verifying the price'],
  coord_quote: ['Sent to Coordinator for quotation', 'Coordinator preparing quotation'],
  eng_quote: ['Quotation submitted', 'Quotation accepted by engineer'],
  on_hold: ['On hold with Coordinator'],
  purchase_dispatch: ['PO requested from Purchase', 'Purchase processing PO'],
  coord_decide: ['Hold or cancel asked of Coordinator', 'Coordinator deciding'],
  on_hold_dispatch: ['On hold with Coordinator'],
  observation: ['Under observation with engineer'],
  purchase_faulty: ['Faulty reported to Purchase', 'Purchase handling the faulty spare'],
  purchase_replacement: ['Faulty sent back to Purchase', 'Purchase sending replacement'],
};
export const statusOf = (r) => {
  const on = Boolean(r.accepted_by);
  if (r.step === 'coord_pr') return on ? 'PR processing' : r.kind === 'request' ? 'Quotation approved' : 'Sent to Coordinator for PR';
  if (r.step === 'receipt') return on ? 'Engineer confirming receipt' : (r.faulty_qty > 0 ? 'Replacement dispatched to engineer' : 'Dispatched to engineer');
  if (r.step === 'return_dispatch') { const who = r.kind === 'stock' ? 'Coordinator' : 'Engineer'; return on ? `${who} sending the faulty spare back` : `${who} to send the faulty spare back`; }
  const w = STATUS[r.step];
  return w ? (on && w[1] ? w[1] : w[0]) : stepOf(r.step).label;
};

/** Each role its own colour (the user, 11 Nov): the step's buttons take the colour of whoever works it. */
const ROLE_KEY = { Engineer: 'engineer', 'Team Lead': 'team_lead', Coordinator: 'coordinator', Purchase: 'purchase', PV: 'pv' };
export const roleOfStep = (s) => ROLE_KEY[STEPS[s]?.who] ?? null;
export const NO_ACCEPT = new Set(['on_hold', 'on_hold_dispatch', 'observation', 'eng_fix']);

/** Stages for TAT, in the order a request meets them. */
export const TAT_STEPS = ['tl_review', 'coord_initial', 'tl_clarify', 'purchase_rates', 'pv', 'coord_quote', 'eng_quote', 'coord_pr',
  'purchase_dispatch', 'coord_decide', 'receipt', 'purchase_faulty', 'return_dispatch', 'purchase_replacement'];

/** What each event says in the timeline. */
export const ACTIONS = {
  raise: 'Raised', raise_stock: 'Raised stock request', accept: 'Accepted', approve: 'Approved',
  edit: 'Changed the request', close: 'Closed', ask: 'Asked to clarify', reply: 'Answered', to_purchase: 'Sent to Purchase for rates',
  sap_confirm: 'SAP rate sent to Purchase to confirm', sap_pr: 'SAP rate, straight to PR', approve_sap: 'Approved the SAP rate',
  rates: 'Rates sent to PV', rates_pr: 'Rates in, straight to PR', pick_original: 'Picked the original',
  pick_compatible: 'Picked the compatible', return: 'Sent back', quotation: 'Closed as quotation only', cancel: 'Cancelled',
  hold: 'Put on hold', resume: 'Taken off hold', pr: 'Raised the PR', save_po: 'Saved the PO', dispatch: 'Dispatched',
  ask_hold: 'Asked to hold', ask_cancel: 'Asked to cancel', deny: 'Said go ahead', received: 'Received',
  replacement_received: 'Received the replacement', cancel_po: 'Cancelled the PO', to_stock: 'Moved to stock',
  returned: 'Sent the faulty spare back', replacement: 'Dispatched a replacement', reopen: 'Reopened', note: 'Note',
  consume: 'Used from stock', send_back: 'Sent back to correct', reject: 'Rejected', resend: 'Corrected and sent again',
  withdraw: 'Withdrawn', quote: 'Sent the quotation', quote_yes: 'Customer approved the quotation', quote_no: 'Customer did not approve the quotation',
};

/* ------------------------------------------------------------- time -- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ist = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600000);
export const dayText = (iso) => {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; }
  const t = ist(iso); return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
};
export const whenText = (iso) => {
  if (!iso) return '';
  const t = ist(iso); const h = t.getUTCHours(); const m = String(t.getUTCMinutes()).padStart(2, '0');
  return `${dayText(iso)}, ${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
};
export const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

/** "2 d 4 h", "3 h 10 m", "12 m". */
export function spanText(secs) {
  if (secs == null) return '';
  const m = Math.floor(secs / 60); const h = Math.floor(m / 60); const d = Math.floor(h / 24);
  if (d >= 1) return `${d} d ${h % 24} h`;
  if (h >= 1) return `${h} h ${m % 60} m`;
  return `${Math.max(0, m)} m`;
}

/** How long it has waited with whoever has it now, against the stage's target: good, near (75%) or late. */
export function clockOf(r, targets, now = Date.now()) {
  if (r.done || NO_ACCEPT.has(r.step)) return null;
  const t = targets?.[r.step];
  const accepted = Boolean(r.accepted_at);
  const since = new Date(accepted ? r.accepted_at : r.step_since).getTime();
  const secs = Math.max(0, (now - since) / 1000);
  const limit = t ? Number(accepted ? t.process_h : t.accept_h) * 3600 : null;
  const tone = !limit ? 'good' : secs > limit ? 'late' : secs > limit * 0.75 ? 'near' : 'good';
  return { secs, tone, accepted, text: spanText(secs) };
}

export function periodRange(p) {
  if (p.id === 'all') return [null, null];
  if (p.id === 'month') { const m = todayIst().slice(0, 7); return [`${m}-01`, null]; }
  return [p.from || null, p.to || null];
}

export const money = (n) => (n == null || n === '' ? '' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const withTax = (rate, tax) => (rate == null ? null : Number(rate) * (1 + Number(tax || 0) / 100));
export const person = (name, code) => (name ? (code ? `${name} (${code})` : name) : '');

/* ----------------------------------------------------------- photos -- */

/** Into the request's own folder; a request being raised names its folder before it exists. */
export async function uploadPhoto(folder, file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from('qt-photos').upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}
/** Signed links last an hour; reused for 50 minutes, then (or when one fails to load) a fresh one is made. */
const urls = new Map();
export async function photoUrl(path, fresh = false) {
  const hit = urls.get(path);
  if (!fresh && hit && Date.now() - hit.at < 50 * 60 * 1000) return hit.url;
  const { data, error } = await supabase.storage.from('qt-photos').createSignedUrl(path, 3600);
  if (error) throw new Error(error.message);
  urls.set(path, { url: data.signedUrl, at: Date.now() });
  return data.signedUrl;
}

/* ------------------------------------------------------------- TAT -- */

/**
 * From the events: each stage's and each person's accept and process times, and how many went past the target.
 * An accept event carries the wait (accept_s); the action that finishes a stage carries the work (process_s).
 */
export function tatOf(events, targets) {
  const stages = new Map(); const people = new Map();
  const bump = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
  const blank = () => ({ acc: 0, accN: 0, accLate: 0, pro: 0, proN: 0, proLate: 0 });
  for (const e of events) {
    if (!TAT_STEPS.includes(e.step)) continue;
    const t = targets?.[e.step];
    const s = bump(stages, e.step, blank);
    const p = bump(people, e.by ?? '—', () => ({ name: e.by_name, code: e.by_code, ...blank(), late: [], stages: new Set() }));
    if (e.action === 'accept' && e.accept_s != null) {
      const late = t && e.accept_s > Number(t.accept_h) * 3600;
      s.acc += e.accept_s; s.accN += 1; p.acc += e.accept_s; p.accN += 1; p.stages.add(e.step);
      if (late) { s.accLate += 1; p.accLate += 1; p.late.push({ ...e, kind: 'accept', secs: e.accept_s }); }
    } else if (e.process_s != null) {
      const late = t && e.process_s > Number(t.process_h) * 3600;
      s.pro += e.process_s; s.proN += 1; p.pro += e.process_s; p.proN += 1; p.stages.add(e.step);
      if (late) { s.proLate += 1; p.proLate += 1; p.late.push({ ...e, kind: 'process', secs: e.process_s }); }
    }
  }
  return {
    stages: TAT_STEPS.filter((k) => stages.has(k)).map((k) => ({ step: k, ...stages.get(k) })),
    people: [...people.entries()].map(([id, v]) => ({ id, ...v, stages: [...v.stages] }))
      .sort((a, b) => (b.accLate + b.proLate) - (a.accLate + a.proLate) || (a.name ?? '').localeCompare(b.name ?? '')),
  };
}

/* ----------------------------------------------------------- Excel -- */

const hours = (s) => (s == null ? '' : Math.round((s / 3600) * 10) / 10);

/** Everything, one row a request with every stage's times (idea 13), and the TAT by person. */
export async function exportAll(list, events, targets, label) {
  const byReq = new Map();
  for (const e of events) {
    if (!byReq.has(e.request_id)) byReq.set(e.request_id, {});
    const m = byReq.get(e.request_id);
    if (!TAT_STEPS.includes(e.step)) continue;
    const k = m[e.step] ?? (m[e.step] = { a: 0, p: 0, aBy: '', pBy: '' });
    if (e.action === 'accept' && e.accept_s != null) { k.a += e.accept_s; k.aBy = person(e.by_name, e.by_code); }
    else if (e.process_s != null) { k.p += e.process_s; k.pBy = person(e.by_name, e.by_code); }
  }
  const columns = [
    { header: 'Request', key: 'no' }, { header: 'Type', key: 'type' }, { header: 'Status', key: 'status' },
    { header: 'Raised on', key: 'raised' }, { header: 'Engineer', key: 'eng' }, { header: 'Team Lead', key: 'tl' },
    { header: 'State', key: 'state' }, { header: 'District', key: 'district' }, { header: 'Hospital', key: 'hospital' },
    { header: 'Contract', key: 'category' }, { header: 'Equipment', key: 'equipment' }, { header: 'Make', key: 'make' },
    { header: 'Model', key: 'model' }, { header: 'Serial no', key: 'serial' }, { header: 'Spare', key: 'spare' },
    { header: 'Part no', key: 'part_no' }, { header: 'Qty', key: 'qty', numeric: true }, { header: 'Approved qty', key: 'approved_qty', numeric: true },
    { header: 'Original vendor', key: 'orig_vendor' }, { header: 'Original rate', key: 'orig_rate', numeric: true }, { header: 'Original tax %', key: 'orig_tax', numeric: true },
    { header: 'Compatible vendor', key: 'comp_vendor' }, { header: 'Compatible rate', key: 'comp_rate', numeric: true }, { header: 'Compatible tax %', key: 'comp_tax', numeric: true },
    { header: 'Picked', key: 'picked' }, { header: 'PR no', key: 'pr_no' }, { header: 'PR date', key: 'pr_day' },
    { header: 'Item code', key: 'item_code' }, { header: 'PO no', key: 'po_no' }, { header: 'PO date', key: 'po_day' },
    { header: 'Vendor', key: 'vendor' }, { header: 'Sent by', key: 'track_mode' }, { header: 'Tracking no', key: 'track_no' },
    { header: 'Received', key: 'received_qty', numeric: true }, { header: 'Used', key: 'used_qty', numeric: true },
    { header: 'Faulty', key: 'faulty_qty', numeric: true }, { header: 'Coordinator', key: 'coord' }, { header: 'Purchase', key: 'pur' },
    { header: 'PV', key: 'pv' }, { header: 'Closed on', key: 'closed' }, { header: 'Reason', key: 'close_note' },
  ];
  for (const k of TAT_STEPS) {
    columns.push({ header: `${STEPS[k].label} · accept (h)`, key: `${k}_a`, numeric: true });
    columns.push({ header: `${STEPS[k].label} · process (h)`, key: `${k}_p`, numeric: true });
  }
  const rows = list.map((r) => {
    const t = byReq.get(r.id) ?? {};
    const row = {
      ...r, type: r.kind === 'stock' ? 'Stock' : 'Request', status: stepOf(r.step).label, raised: whenText(r.created_at),
      eng: person(r.engineer_name, r.engineer_code), tl: r.team_lead_name ?? '', coord: r.coord_name ?? '', pur: r.purchase_name ?? '',
      pv: r.pv_name ?? '', pr_day: dayText(r.pr_date), po_day: dayText(r.po_date), closed: whenText(r.closed_at),
      picked: r.picked === 'original' ? 'Original' : r.picked === 'compatible' ? 'Compatible' : '',
    };
    for (const k of TAT_STEPS) { row[`${k}_a`] = t[k] ? hours(t[k].a) : ''; row[`${k}_p`] = t[k] ? hours(t[k].p) : ''; }
    return row;
  });
  const tat = tatOf(events, targets);
  const pRows = tat.people.map((p) => ({
    who: person(p.name, p.code), stages: p.stages.map((s) => STEPS[s]?.label ?? s).join(', '),
    accN: p.accN, acc: p.accN ? hours(p.acc / p.accN) : '', accLate: p.accLate,
    proN: p.proN, pro: p.proN ? hours(p.pro / p.proN) : '', proLate: p.proLate,
  }));
  const pCols = [
    { header: 'Person', key: 'who' }, { header: 'Stages', key: 'stages' },
    { header: 'Accepted', key: 'accN', numeric: true }, { header: 'Average accept (h)', key: 'acc', numeric: true }, { header: 'Accepted late', key: 'accLate', numeric: true },
    { header: 'Processed', key: 'proN', numeric: true }, { header: 'Average process (h)', key: 'pro', numeric: true }, { header: 'Processed late', key: 'proLate', numeric: true },
  ];
  saveBlob(await writeBook([{ name: 'Requests', columns, rows }, { name: 'TAT by person', columns: pCols, rows: pRows }]), `Quotation-tracker-${label}.xlsx`);
}
