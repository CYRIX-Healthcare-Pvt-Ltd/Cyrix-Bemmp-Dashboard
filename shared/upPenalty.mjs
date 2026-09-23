/**
 * Uttar Pradesh's penalty, per call — "UP Penalty - Auto dashboard.xlsx",
 * sheet Calc UP, columns Z to AK (the user, 23 Sep).
 *
 * Checked call by call against what that workbook worked out on 23 Sep, all
 * 571 open calls of the day's export, every column: nothing differed.
 *
 * In words:
 *   - The penalty starts eight days after the call was logged (Z = T + 8).
 *   - Down days count from that day to today, both counted — or to the day the
 *     call was completed, when it is Completed, Irrepairable or Canceled and
 *     that day is already past (AA; the hidden Y is the same sum).
 *   - The asset's per-day cost and priority come from the Per Day Cost sheet,
 *     by asset number (AI, AJ); the priority sets a multiple — A 4, B 6,
 *     C&D 10 (AK).
 *   - A penalty is down days × cost (AB). B penalty is that × the multiple
 *     (AD) — none for a call that is burned, a consumable, irrepairable or
 *     physically damaged (Status1 = "BE/Con./PD").
 *   - Total is A + B (AF); per day is each per down day, added (AG).
 *   - The range is the band the per-day cost falls in (AH). The sheet's own
 *     formula leaves a cost between 500 and 501 in no band at all; here it is
 *     in "501 to 1000", the band above 500.
 *
 * Days are Excel serials, as the rest of the dataset keeps them.
 */

/** Statuses that end a call, when its completed day is already past (Status!A3, A5, E3). */
const CLOSING = new Set(['completed', 'irrepairable', 'canceled', 'cancelled']);

/** Status1 = "BE/Con./PD": no B penalty (Status!A2, A4, A5, A7). */
const NO_B = new Set(['burned equipment', 'consumable item', 'irrepairable', 'physically damaged']);

/** The priority's multiple for B penalty (AK). */
export const PRIO_RANGE = { A: 4, B: 6, 'C&D': 10 };

/** Days between the call being logged and its penalty starting (Z = T + 8). */
export const UP_GRACE_DAYS = 8;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** The band a per-day cost falls in (AH). */
export function penaltyBand(cost) {
  const c = Number(cost) || 0;
  if (c <= 50) return '< 50';
  if (c <= 500) return '51 to 500';
  if (c <= 1000) return '501 to 1000';
  if (c <= 3000) return '1001 to 3000';
  if (c <= 10000) return '3001 to 10000';
  return '>10000';
}

/**
 * One call's penalty, as of `today`.
 *
 * @param {object} call
 * @param {number} call.loggedDay     Excel serial of the day it was logged; -1 when unknown
 * @param {number} call.completedDay  Excel serial of the day it was completed; -1 when not
 * @param {string} call.status        the export's Status
 * @param {number} call.perDayCost    from Per Day Cost, 0 when the asset is not there
 * @param {string} call.prio          A, B or C&D; '' when the asset is not there
 * @param {number} today              Excel serial of today
 */
export function upPenalty({ loggedDay, completedDay = -1, status, perDayCost = 0, prio = '' }, today) {
  const cost = Number(perDayCost) || 0;
  const range = PRIO_RANGE[String(prio ?? '').trim()] ?? 0;
  if (!(loggedDay > 0)) {
    return { startDay: -1, downDays: 0, aPenalty: 0, bPenalty: 0, total: 0, perDay: 0, band: penaltyBand(cost), perDayCost: cost, prio, prioRange: range };
  }
  const startDay = loggedDay + UP_GRACE_DAYS;
  const ended = CLOSING.has(norm(status)) && completedDay > 0 && completedDay < today;
  const downDays = Math.max((ended ? completedDay : today) - startDay + 1, 0);
  const aPenalty = downDays * cost;
  const bPenalty = NO_B.has(norm(status)) ? 0 : downDays * cost * range;
  const perDay = downDays ? (aPenalty + bPenalty) / downDays : 0;
  return {
    startDay, downDays, aPenalty, bPenalty, total: aPenalty + bPenalty, perDay,
    band: penaltyBand(cost), perDayCost: cost, prio, prioRange: range,
  };
}
