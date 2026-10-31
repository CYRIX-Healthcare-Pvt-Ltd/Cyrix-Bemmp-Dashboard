/**
 * PM checklist — a project inside BEMMP (supabase/migrations/0014_pm_checklist.sql).
 *
 * An engineer opens the equipment's checklist, fills it at the site and
 * submits it; every other role on the project reads the reports, the summary
 * and an Excel per equipment (the user, 31 Oct). The checklists themselves
 * are in pmChecklists.js.
 */
import { supabase } from './supabase.js';
import { writeBook, saveBlob } from './xlsx.js';
import { CHECKLISTS, BAD } from './pmChecklists.js';

export const PM_PROJECT = { id: 'pm', short: 'PM', name: 'PM checklist' };

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const loadPmMe = () => (supabase ? rpc('pm_me') : Promise.resolve(null));
export const loadPmList = (from, to) => rpc('pm_list', { p_from: from || null, p_to: to || null });
export const loadFacilities = () => rpc('pm_facilities');
export const submitPm = (report) => rpc('pm_submit', { p: report });
export const loadReport = async (id) =>
  (await rpc('pm_reports_full', { p_ids: [id], p_equipment: null, p_from: null, p_to: null }))?.[0] ?? null;

export const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
export const nowTime = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(11, 16);

/** From and To of a period, as the server takes them. */
export function periodRange(p) {
  if (p.id === 'all') return [null, null];
  if (p.id === 'month') { const m = todayIst().slice(0, 7); return [`${m}-01`, null]; }
  return [p.from || null, p.to || null];
}

/*
 * A checklist half filled stays on the phone until it is submitted: a call,
 * a lock screen or a closed tab must not cost the engineer forty rows.
 */
const draftKey = (code) => `bemmp-pm-draft-${code}`;
const has = (x) => String(x ?? '').trim() !== '';
const answered = (a) => Boolean(a) && (has(a.s) || has(a.r) || Object.values(a.v ?? {}).some(has)
  || (a.rows ?? []).some((x) => Object.values(x).some(has)));
// Only what the engineer typed or pressed counts; the date and start time fill themselves.
const entered = (d) => Boolean(d) && (Object.values(d.answers ?? {}).some(answered)
  || ['equipment_name', 'barcode', 'pm_wo', 'facility', 'notes', 'customer_name'].some((k) => has(d[k]))
  || d.handed_over != null);
export function readDraft(code) {
  try { const d = JSON.parse(localStorage.getItem(draftKey(code)) ?? 'null'); return entered(d) ? d : null; } catch { return null; }
}
export function saveDraft(code, draft) {
  try {
    if (entered(draft)) localStorage.setItem(draftKey(code), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(code));
  } catch { /* kept in memory only */ }
}
export function dropDraft(code) {
  try { localStorage.removeItem(draftKey(code)); } catch { /* nothing kept */ }
}

/** Minutes from start to end, across midnight if it has to. */
export function duration(start, end) {
  if (!start || !end) return null;
  const [a, b] = [start, end].map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  const d = b >= a ? b - a : b + 1440 - a;
  return `${Math.floor(d / 60)} h ${String(d % 60).padStart(2, '0')} min`;
}

/** One answer in words: the choice, the readings with their units, the remark. */
export function answerText(it, a) {
  if (!a) return '';
  if (it.kind === 'text') return a.r ?? '';
  if (it.kind === 'params') {
    return (a.rows ?? []).filter((r) => r.p || r.set || r.meas || r.r)
      .map((r) => [r.p, r.set && `set ${r.set}`, r.meas && `measured ${r.meas}`, r.r].filter(Boolean).join(', ')).join('; ');
  }
  const vals = (it.fields ?? []).filter((f) => a.v?.[f.k]).map((f) => `${f.label ? `${f.label} ` : ''}${a.v[f.k]}${f.unit ? ` ${f.unit}` : ''}`);
  return [a.s, ...vals, a.r].filter(Boolean).join(' · ');
}

export const isBad = (a) => Boolean(a && BAD.has(a.s));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-30' → '30 Oct 2026'. */
export function dayText(d) {
  if (!d) return '';
  const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return `${dd} ${MONTHS[m - 1]} ${y}`;
}
/** '13:05' → '1:05 pm'. */
export function timeText(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
/** A timestamp as India reads it: '31 Oct 2026, 11:20 am'. */
export function whenText(ts) {
  if (!ts) return '';
  const ist = new Date(Date.parse(ts) + 5.5 * 3600000).toISOString();
  return `${dayText(ist.slice(0, 10))}, ${timeText(ist.slice(11, 16))}`;
}

// The cost centre names the BEMMP: KLBEMP is Kerala's.
const BEMMP_STATE = { KL: 'Kerala', AP: 'Andhra Pradesh', UP: 'Uttar Pradesh', RJ: 'Rajasthan' };
export const bemmpState = (cc) => (cc && /BEMP$/.test(cc) ? BEMMP_STATE[cc.slice(0, 2)] ?? '' : '');

/**
 * One workbook, one sheet per equipment, one row per PM: who did it, when,
 * which BEMMP, then every checklist row (the user, 31 Oct). `ids` limits it to
 * the reports on screen; without them it is the whole period.
 */
export async function exportReports({ from, to, ids, label }) {
  const reports = await rpc('pm_reports_full', { p_ids: ids ?? null, p_equipment: null, p_from: from || null, p_to: to || null });
  if (!reports?.length) throw new Error('No PM to download in this period.');
  const sheets = [];
  for (const c of CHECKLISTS) {
    const mine = reports.filter((r) => r.equipment === c.code);
    if (!mine.length) continue;
    const columns = [
      { header: 'Done by', key: 'engineer_name' },
      { header: 'E-code', key: 'engineer_code' },
      { header: 'BEMMP', key: 'cost_centre' },
      { header: 'State', key: 'state' },
      { header: 'PM date', key: 'day' },
      { header: 'Start time', key: 'start' },
      { header: 'End time', key: 'end' },
      { header: 'Duration', key: 'duration' },
      { header: 'Submitted on', key: 'submitted' },
      { header: 'Hospital', key: 'facility' },
      { header: 'Equipment name', key: 'equipment_name' },
      { header: 'Barcode', key: 'barcode' },
      { header: 'PM WO', key: 'pm_wo' },
      { header: 'Rows not OK', key: 'issues', numeric: true },
    ];
    const rowCols = [];
    for (const s of c.sections) {
      for (const it of s.items) {
        rowCols.push({ it, key: `i:${it.id}` });
        columns.push({ header: s.title ? `${s.title} · ${it.label}` : it.label, key: `i:${it.id}` });
      }
    }
    columns.push(
      { header: 'Notes / overall observation', key: 'notes' },
      { header: 'Handed over in good condition', key: 'handed' },
      { header: 'Customer name', key: 'customer_name' },
    );
    const rows = mine.map((r) => {
      const start = r.start_time?.slice(0, 5);
      const end = r.end_time?.slice(0, 5);
      const row = {
        ...r,
        state: bemmpState(r.cost_centre),
        day: dayText(r.pm_date),
        start: timeText(start),
        end: timeText(end),
        duration: duration(start, end) ?? '',
        submitted: whenText(r.submitted_at),
        handed: r.handed_over == null ? '' : r.handed_over ? 'Yes' : 'No',
      };
      for (const { it, key } of rowCols) row[key] = answerText(it, r.answers?.[it.id]);
      return row;
    });
    sheets.push({ name: c.name, columns, rows });
  }
  saveBlob(await writeBook(sheets), `PM-checklists-${label}.xlsx`);
  return { reports: reports.length, sheets: sheets.length };
}
