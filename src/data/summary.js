/**
 * The ticket tracker's Summary, computed the way the business's own workbook
 * computes it.
 *
 * This is deliberately **not** the dashboard's penalty arithmetic, and the
 * difference is not an oversight. `KL Ticket Wise - Tracker.xlsx` drives its
 * Summary sheet off the export's own `Down Days` column, while the dashboard
 * derives age as `referenceDay - loggedDay`. On the Kerala artifact those
 * disagree by exactly one day on 667 of 807 open rows — the export counts from
 * the day after logging — which comes out as 184 penalty calls here against the
 * dashboard's 197. The meeting reconciles its figures against that workbook, so
 * the tracker matches the workbook and the dashboard keeps its own rule.
 *
 * Translated from the sheet, with the column letters it uses:
 *
 * | Summary | Formula there | Here |
 * |---|---|---|
 * | Total Open Calls | `COUNTIFS(Final!D:D, district)` | every unresolved row |
 * | Penalty Calls | `+ P>7 + N=""` | open bucket AND `downDays > window` |
 * | Penalty | `SUMIFS(Final!R:R, …)` | `(downDays - grace) x rate`, floored |
 * | Per Day | `SUMIFS(Final!Q:Q, …)` | `dayRate` |
 * | Cont % | `D/SUM(D$21:D$40)` | share of the per-day total |
 *
 * Two of those need saying out loud:
 *
 * **`Final!N` is Ticket Remark, not Resolved Date.** The Final sheet already
 * holds only unresolved rows — 0 of its 8,516 carry a resolved date — so
 * `N=""` is not a redundant test, it is exactly this project's OPEN bucket:
 * unresolved *and* unremarked. Parked calls are counted in Total Open Calls and
 * excluded from every penalty figure, which is what the sheet does.
 *
 * **Penalty type comes from the meeting, not the export.** It is
 * `meeting_note.penalty_type`, so a penalty call nobody has categorised yet
 * appears in the district block and in no type row. The sheet has the same gap
 * and says nothing about it — its block-1 total reads 385 calls against
 * block-2's 376 — so `untyped` is returned here to be shown rather than left as
 * an unexplained difference between two totals on one screen.
 */

import { BUCKET } from './store.js';
import { penaltyWindows } from './query.js';

/**
 * @param ds            the dataset
 * @param idx           every *unresolved* row — open and parked both
 * @param penaltyTypeOf `(row) => string | null`, from the meeting notes
 * @param typeNames     the penalty-type vocabulary, in the order to show it
 */
export function trackerSummary(ds, idx, penaltyTypeOf, typeNames = []) {
  const { cols, dict } = ds;
  const windows = penaltyWindows(ds);
  const grace = ds.meta.graceDays ?? 7;
  const hasZone = dict.zone.length > 0;

  const districts = new Map();
  const types = new Map(typeNames.map((name) => [name, { name, count: 0, value: 0 }]));
  const total = { open: 0, penaltyCalls: 0, accrued: 0, perDay: 0 };
  const untyped = { count: 0, value: 0 };

  const districtRow = (id) => {
    let d = districts.get(id);
    if (!d) {
      d = {
        district: dict.district[id] ?? '—',
        zone: '',
        open: 0,
        penaltyCalls: 0,
        accrued: 0,
        perDay: 0,
        byType: new Map(),
      };
      districts.set(id, d);
    }
    return d;
  };

  for (let k = 0; k < idx.length; k++) {
    const row = idx[k];
    const d = districtRow(cols.district[row]);
    // Zone is a label on the district rather than a grouping of its own — it is
    // one-to-one with district in Kerala and absent in Andhra.
    if (hasZone && !d.zone) d.zone = dict.zone[cols.zone[row]] ?? '';

    d.open += 1;
    total.open += 1;

    // Everything below is the penalty test, and it is the sheet's: open only,
    // and the export's own Down Days past the window.
    if (cols.bucket[row] !== BUCKET.OPEN) continue;
    const window = windows[cols.equipmentType[row] + 1] ?? windows[0];
    const down = cols.downDays[row];
    if (!(down > window)) continue;

    const rate = cols.dayRate[row];
    // Floored at zero the way `closurePenalty` is: a ticket inside its grace
    // window owes nothing, and the workbook's own subtraction would go negative.
    const accrued = Math.max(0, down - grace) * rate;

    d.penaltyCalls += 1;
    d.perDay += rate;
    d.accrued += accrued;
    total.penaltyCalls += 1;
    total.perDay += rate;
    total.accrued += accrued;

    const name = penaltyTypeOf(row);
    const bucket = name ? types.get(name) : null;
    if (bucket) {
      bucket.count += 1;
      bucket.value += rate;
      const cell = d.byType.get(name) ?? { count: 0, value: 0 };
      cell.count += 1;
      cell.value += rate;
      d.byType.set(name, cell);
    } else {
      // Either nothing recorded, or a value no longer in the vocabulary. Both
      // are "not categorised" to the meeting, and both are why the two blocks
      // can disagree.
      untyped.count += 1;
      untyped.value += rate;
    }
  }

  const typeRows = [...types.values()];
  const typeTotal = typeRows.reduce(
    (acc, t) => ({ count: acc.count + t.count, value: acc.value + t.value }),
    { count: 0, value: 0 },
  );

  return {
    // Alphabetical by district, which is the order the sheet lists them in.
    districts: [...districts.values()].sort((a, b) => a.district.localeCompare(b.district)),
    total,
    // `Cont %` is the share of the per-day total, not of the call count — the
    // sheet divides D by SUM(D), and D is the money column.
    types: typeRows.map((t) => ({
      ...t,
      share: typeTotal.value ? t.value / typeTotal.value : 0,
    })),
    typeTotal,
    untyped,
    typeNames,
    hasZone,
  };
}
