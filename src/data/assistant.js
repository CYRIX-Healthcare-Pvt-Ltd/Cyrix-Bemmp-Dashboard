/**
 * Natural-language querying over the loaded dataset.
 *
 * The model's only job is to turn a sentence into a small JSON spec. It never
 * sees ticket rows, dictionaries, names or figures — those stay in the browser
 * and the answer is computed here from the typed arrays. That keeps engineer
 * names and phone numbers out of any third-party service, and it means the
 * numbers quoted back are the same ones the dashboard shows rather than
 * something a language model estimated.
 */
import { BUCKET, monthStart, parseEngineer, formatDay, serialToISO } from './store.js';
import {
  filterRows, summarize, rowsInBucket, penaltyRows, accruingRows, closedInRange,
  closurePenalty, analyzeRepeats, resolvedRows, aggregateBy, countBy, topN,
  FTFR_MAX_DAYS, ftfrSettledThrough, maxResolvedDay,
} from './query.js';

/* --------------------------------------------------------------- measures -- */

const MS_PER_DAY = 86400000;

const inr = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const int = (v) => Math.round(v).toLocaleString('en-IN');

/**
 * A measure label as it should read mid-sentence.
 *
 * Lowercasing suits "the highest average resolution time", but an acronym must
 * survive it — "the highest ftfr" is wrong on screen and wrong read aloud.
 */
function measureName(measure) {
  return /^[A-Z]{2,}$/.test(measure.label) ? measure.label : measure.label.toLowerCase();
}

/**
 * Each measure declares which rows it runs over and how a single row scores.
 * `kind` decides how a group of rows collapses: counts add up, rates and means
 * divide by the group size.
 */
export const MEASURES = {
  calls: {
    label: 'Total calls',
    describe: 'how many tickets were logged',
    kind: 'count',
    rows: (ds, idx) => idx,
    format: int,
    unit: 'calls',
  },
  open: {
    label: 'Open calls',
    describe: 'unresolved with no ticket remark — the live backlog',
    kind: 'count',
    rows: (ds, idx) => rowsInBucket(ds, idx, BUCKET.OPEN),
    format: int,
    unit: 'open calls',
    worstOrder: 'desc',
  },
  unresolved: {
    label: 'Unresolved calls',
    describe: 'no resolved date but carrying a remark, i.e. out of service scope',
    kind: 'count',
    rows: (ds, idx) => rowsInBucket(ds, idx, BUCKET.PARKED),
    format: int,
    unit: 'unresolved calls',
    worstOrder: 'desc',
  },
  resolved: {
    label: 'Resolved calls',
    describe: 'tickets that have a resolved date',
    kind: 'count',
    rows: (ds, idx) => rowsInBucket(ds, idx, BUCKET.RESOLVED),
    format: int,
    unit: 'resolved calls',
  },
  penalty: {
    label: 'Penalty calls',
    describe: 'HOW MANY open calls have passed their SLA window — a count, not money. '
      + 'Only for "how many penalty calls"; bare "penalty" means rupees, use perDayPenalty',
    kind: 'count',
    rows: (ds, idx, ctx) => penaltyRows(ds, idx, ctx.referenceDay),
    format: int,
    unit: 'penalty calls',
    worstOrder: 'desc',
  },
  repeat: {
    label: 'Repeat calls',
    describe: 'the 2nd and later call on the same asset',
    kind: 'count',
    rows: (ds, idx) => analyzeRepeats(ds, idx).rows,
    format: int,
    unit: 'repeat calls',
    worstOrder: 'desc',
  },
  ftfr: {
    label: 'FTFR',
    describe: `first time fix rate — share of resolved calls fixed within ${FTFR_MAX_DAYS} day`,
    kind: 'rate',
    rows: (ds, idx) => resolvedRows(ds, idx),
    valueOf: (ds, i) => (ds.cols.resolvedDay[i] - ds.cols.loggedDay[i] <= FTFR_MAX_DAYS ? 1 : 0),
    format: (v) => `${(v * 100).toFixed(1)}%`,
    minSamples: 20,
    unit: '',
    // The one measure where worst is the *bottom* of the ranking.
    worstOrder: 'asc',
  },
  resolution: {
    label: 'Average resolution time',
    describe: 'mean days from logged to resolved, over resolved calls',
    kind: 'mean',
    rows: (ds, idx) => resolvedRows(ds, idx),
    valueOf: (ds, i) => ds.cols.resolvedDay[i] - ds.cols.loggedDay[i],
    format: (v) => `${v.toFixed(1)} d`,
    minSamples: 20,
    lowerIsBetter: true,
    unit: '',
    // A long turnaround is the bad one, so worst is the slowest, not the fastest.
    worstOrder: 'desc',
  },
  perDayPenalty: {
    label: 'Per-day penalty',
    describe: 'RUPEES accruing each day on open tickets past their grace window. '
      + 'This is what "penalty" means unqualified — what the backlog is costing',
    kind: 'sum',
    needsRateCard: true,
    rows: (ds, idx, ctx) => accruingRows(ds, ctx.undatedIdx, ctx.dayFrom, ctx.dayTo),
    valueOf: (ds, i) => ds.cols.dayRate[i],
    format: (v) => `${inr(v)}/day`,
    unit: '',
  },
  closurePenalty: {
    label: 'Closure penalty',
    describe: 'rupees settled on tickets closed inside the period',
    kind: 'sum',
    needsRateCard: true,
    rows: (ds, idx, ctx) => ctx.closedIdx,
    valueOf: (ds, i) => closurePenalty(ds, i),
    format: inr,
    unit: '',
  },
  /*
   * Every headline figure at once, for "how are we doing".
   *
   * Asked for a summary, the model either wrote prose about what the contract
   * *is* — true, and containing no numbers — or picked one measure and answered
   * with total calls alone. Neither is what somebody means by "give me an
   * overview", and neither could be fixed by prompting: a summary is not a
   * measure with a dimension, it is a different shape of answer.
   *
   * Computed here like everything else, so the figures are the dashboard's own.
   */
  overview: {
    label: 'Contract summary',
    describe: 'EVERY headline figure at once — total, open, unresolved, resolved, '
      + 'penalty calls, FTFR and average resolution. Use this for "summary", '
      + '"overview", "how are we doing", or any request for the overall picture '
      + 'rather than one number',
    kind: 'overview',
    unit: '',
  },
};

export const DIMENSIONS = {
  // Kerala's North/South, above district in the same way the drill nests them.
  // Andhra's export has no such column, so its dictionary is empty there and
  // `datasetContext` tells the model not to reach for it.
  zone: 'zone',
  district: 'district',
  facility: 'facilityName',
  equipment: 'equipment',
  manufacturer: 'manufacturer',
  engineer: 'engineer',
  department: 'department',
  facilityType: 'facilityType',
  /*
   * The rest of the artifact's dictionaries. Every categorical column the
   * export carries is reachable, so a question about a field nobody thought to
   * expose is answerable rather than met with "I can't do that".
   *
   * Two columns are deliberately absent, and they are absent from the artifact
   * itself rather than merely from this list: `Customer mobile`, which is
   * personal data the dashboard has no use for, and Kerala's `AH Last Remark`,
   * which embeds names and timestamps. Neither is in `tickets.bin`, so there is
   * nothing here to leak even by mistake.
   *
   * `engineer` is the one that needs care and already has it — the raw value is
   * `CODE - Name - phone`, and `dimensionLabel` strips everything but the name
   * before it reaches an answer or the voice output.
   */
  model: 'model',
  deviceGroup: 'deviceGroup',
  status: 'status',
  lifecycle: 'lifecycle',
  reason: 'parkedReason',
  criticality: 'equipmentType',
  asset: 'barcode',
};

/** Singular and plural, so the summary sentence does not say "5 equipments". */
const DIM_NOUN = {
  zone: ['zone', 'zones'],
  district: ['district', 'districts'],
  facility: ['facility', 'facilities'],
  equipment: ['equipment type', 'equipment types'],
  manufacturer: ['manufacturer', 'manufacturers'],
  engineer: ['engineer', 'engineers'],
  department: ['department', 'departments'],
  facilityType: ['facility type', 'facility types'],
  model: ['model', 'models'],
  deviceGroup: ['device group', 'device groups'],
  status: ['status', 'statuses'],
  lifecycle: ['lifecycle state', 'lifecycle states'],
  reason: ['reason', 'reasons'],
  criticality: ['criticality', 'criticalities'],
  asset: ['asset', 'assets'],
};

/**
 * The engineer column holds `CODE - Name - phone`. Only the name belongs in an
 * answer — the rest is noise on screen and a phone number read aloud by the
 * voice output.
 */
function dimensionLabel(dimension, raw) {
  if (dimension !== 'engineer') return raw;
  return parseEngineer(raw)?.name ?? raw;
}

/**
 * Start of the calendar month `n - 1` months before the newest data.
 *
 * "Last 3 months" means three calendar months including this one, which is how a
 * service review reads it — not the previous 90 days.
 */
function monthsBackStart(maxDay, n) {
  const d = new Date((maxDay - 25569) * MS_PER_DAY);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (Math.max(1, n) - 1), 1);
  return Math.round(target / MS_PER_DAY) + 25569;
}

const RANGES = {
  current: null, // whatever the dashboard is already showing
  month: (r) => [monthStart(r.maxDay), r.maxDay],
  last30: (r) => [r.maxDay - 29, r.maxDay],
  last90: (r) => [r.maxDay - 89, r.maxDay],
  last365: (r) => [r.maxDay - 364, r.maxDay],
  all: (r) => [r.minDay, r.maxDay],
};

/* ------------------------------------------------------------------ tool --- */

/**
 * The function schema handed to the model. Deliberately small: enumerations only,
 * no data. Free-text filter values are resolved against the dictionaries here.
 */
export const QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'query_dashboard',
    description:
      'Answer a question about BEMMP biomedical service tickets by describing which '
      + 'measure to compute, optionally broken down by a dimension and filtered.',
    parameters: {
      type: 'object',
      properties: {
        measure: {
          type: 'string',
          enum: Object.keys(MEASURES),
          description: Object.entries(MEASURES)
            .map(([k, m]) => `${k}: ${m.describe}`).join('; '),
        },
        dimension: {
          type: 'string',
          enum: [...Object.keys(DIMENSIONS), 'none'],
          description:
            'Break the measure down by this. Use "none" for a single overall figure.',
        },
        order: {
          type: 'string',
          enum: ['desc', 'asc'],
          description:
            'Purely a direction: desc ranks the largest value first, asc the smallest. '
            + 'Default desc. It is NOT "worst first" — which end is bad depends on the '
            + 'measure. For resolution (turnaround), longer is worse, so worst/slowest '
            + 'is desc and best/fastest is asc. For ftfr, a higher rate is better, so '
            + 'worst is asc. For every count measure, more is worse, so worst is desc.',
        },
        limit: { type: 'integer', description: 'How many groups to return, 1-25. Default 8.' },
        range: {
          type: 'string',
          enum: Object.keys(RANGES),
          description:
            'Date window. Use "current" ONLY when the user names no period at all — it '
            + 'keeps whatever the dashboard is already filtered to. If the user says '
            + '"this month" use month, "last 30 days" use last30, "last 90 days" or '
            + '"last quarter" use last90, "this year" or "last 12 months" use last365, '
            + '"all time"/"ever"/"overall" use all.',
        },
        lastMonths: {
          type: 'integer',
          description:
            'For "last N months", give N here (e.g. "last 3 months" -> 3) and it wins '
            + 'over range. Counts whole calendar months including the current one.',
        },
        fromDate: {
          type: 'string',
          description:
            'Explicit start date as YYYY-MM-DD. Use this whenever the user names any '
            + 'specific date or month, and it wins over range and lastMonths. Numeric '
            + 'dates are day-first Indian format: "1-01-26" is 2026-01-01, "23-07-26" '
            + 'is 2026-07-23. A month name followed by a bare two-digit number is a '
            + 'YEAR, not a day, and means that whole month: "dec 25" is 2025-12-01, '
            + '"from jan 26" is 2026-01-01. Only "25 Dec" or "Dec 25th" mean the 25th.',
        },
        toDate: {
          type: 'string',
          description:
            'Explicit end date as YYYY-MM-DD. Omit it for "to date", "till now" or '
            + '"so far", which mean the newest day in the data.',
        },
        filterDimension: {
          type: 'string',
          enum: [...Object.keys(DIMENSIONS), 'none'],
          description: 'Restrict to one value of this dimension, e.g. a single district.',
        },
        filterValue: {
          type: 'string',
          description: 'The value to restrict to, spelled as the user said it.',
        },
      },
      required: ['measure', 'dimension'],
    },
  },
};

/**
 * The escape hatch for anything that is not a data question.
 *
 * Without it a greeting gets forced through `query_dashboard` and comes back as a
 * ticket count, which reads as a machine that did not listen. With two tools the
 * model picks, and "hi" gets a hello.
 */
export const CHAT_TOOL = {
  type: 'function',
  function: {
    name: 'reply_conversationally',
    description:
      'Use for greetings, thanks, small talk, or questions about what this assistant '
      + 'can do — anything that is not a request for a figure from the data.',
    parameters: {
      type: 'object',
      properties: {
        reply: {
          type: 'string',
          description:
            'A warm, brief reply in the first person, at most two sentences. Be human '
            + 'and friendly, not corporate. If the user seems to want data but was '
            + 'vague, offer one concrete example question they could ask.',
        },
      },
      required: ['reply'],
    },
  },
};

/**
 * Compact description of the loaded dataset, for the system prompt.
 *
 * Dates are given as real ISO dates, not the Excel serials the columns hold — the
 * model was being told the range was "46204 to 46226", which it cannot reason
 * about, so "till date" had nothing to anchor to.
 */
/**
 * The baseline Cyra queries against: the whole contract.
 *
 * She used to inherit the dashboard's own filter bar, which made her answers
 * depend on page state nobody was thinking about while typing. "How many open
 * calls in Kannur" gave one number with the panel on This month and a different
 * one on All time, and neither the question nor the answer mentioned a date —
 * so the figure looked wrong rather than scoped. Worse, a district left selected
 * in the panel silently intersected with the district in the question, and the
 * answer for Palakkad was quietly zero.
 *
 * She narrows from everything instead, using only what the question says. The
 * range and the filter in a spec are the model's, and they are the only ones.
 */
export function neutralFilters(ds) {
  return {
    preset: 'all',
    dayFrom: ds.meta.dateRange.minDay,
    dayTo: ds.meta.dateRange.maxDay,
    ...Object.fromEntries([...ENGINE_FILTERS].map((k) => [k, new Set()])),
    bucket: new Set(),
  };
}

export function datasetContext(ds) {
  const iso = (day) => serialToISO(day);
  return [
    `Active contract: ${ds.meta.name}.`,
    `The newest day in this data is ${iso(ds.meta.dateRange.maxDay)}; treat that as `
      + `today for "to date", "till now" and "so far". The data starts `
      + `${iso(ds.meta.dateRange.minDay)}.`,
    'Unless the question names a period, answer over the whole contract — you are '
      + 'not bound by whatever the dashboard is filtered to.',
    ds.meta.penaltyRates
      ? 'This contract has a penalty rate card, so money measures are available.'
      : 'This contract has NO penalty rate card; money measures are unavailable.',
    /*
     * Every state's export has a different schema, and a dimension a contract
     * does not supply has an empty dictionary — asking for it produces "I
     * couldn't find that", which reads as the question being wrong rather than
     * the column being absent. Naming the ones that exist prevents the attempt.
     */
    ds.dict.zone.length
      ? `Zones are ${ds.dict.zone.join(' and ')}, and each contains several districts. `
        + 'Use dimension "zone" when the user says zone, north or south.'
      : 'This contract has NO zone column; never use the zone dimension for it.',
    'A ticket is open only when it has no resolved date AND no ticket remark.',
    'A penalty call is an open call past its SLA window.',
  ].join(' ');
}

/* --------------------------------------------------------------- matching -- */

/**
 * Parses `YYYY-MM-DD` into an Excel day serial, or null.
 *
 * Deliberately strict: a half-understood date silently answering for the wrong
 * period is worse than refusing, which is the failure this whole path exists to
 * fix. Interpreting the user's wording is the model's job; this only accepts the
 * ISO form it was asked to emit.
 */
function parseISODay(text) {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Rejects 2026-02-31 and friends, which Date.UTC would happily roll over.
  if (back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null;
  return Math.round(ms / MS_PER_DAY) + 25569;
}

/**
 * Everyday names for places the data spells differently.
 *
 * Staff say Trivandrum and Calicut; the export says Thiruvananthapuram and
 * Kozhikode. Without this the question simply fails, which reads as the assistant
 * not knowing its own contract. Keyed by normalised form.
 */
const PLACE_ALIASES = {
  // Kerala
  trivandrum: 'thiruvananthapuram',
  tvm: 'thiruvananthapuram',
  calicut: 'kozhikode',
  cochin: 'ernakulam',
  kochi: 'ernakulam',
  ekm: 'ernakulam',
  trichur: 'thrissur',
  quilon: 'kollam',
  alleppey: 'alappuzha',
  palghat: 'palakkad',
  cannanore: 'kannur',
  kasaragod: 'kasargode',
  kasargod: 'kasargode',
  // Andhra Pradesh
  vizag: 'vishakhapatnam',
  visakhapatnam: 'vishakhapatnam',
  vizianagram: 'vizianagaram',
  anantapur: 'ananthpur',
  anantapuram: 'ananthpur',
  cuddapah: 'ysrkadapa',
  kadapa: 'ysrkadapa',
  ongole: 'prakasam',
  vijayawada: 'ntr',
  rajahmundry: 'eastgodavari',
  tirupati: 'sribalaji',
};

/** Punctuation and case dropped, so "YSR Kadapa" and "ysr-kadapa" compare equal. */
const foldName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Levenshtein, capped: past a couple of edits these are different places. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Resolves what the user said to a value the data actually holds.
 *
 * Tried in order, most confident first: exact, a known everyday alias, prefix or
 * substring, then a small edit distance for typos and transliteration drift. The
 * distance is scaled to the word's length so short names cannot collide — at a
 * flat threshold "Kollam" and "Kannur" are close enough to swap.
 */
function matchDictionary(values, text) {
  if (!text) return -1;
  const raw = foldName(text);
  if (!raw) return -1;
  const needle = PLACE_ALIASES[raw] ?? raw;

  let starts = -1;
  let contains = -1;
  let best = -1;
  let bestScore = Infinity;

  for (let i = 0; i < values.length; i++) {
    const hay = foldName(values[i]);

    /*
     * Values that fold away to nothing, and the near-nothing.
     *
     * The engineer column carries a literal "-  -", which folds to the empty
     * string — and `needle.startsWith('')` is true for every needle, so that one
     * entry won every engineer lookup before a real name was ever considered.
     * Asking for Aswin returned it, and the answer was ₹0/day for "-  -".
     *
     * The length floor covers the same failure one step up: a two-character
     * entry would otherwise claim every name beginning with those letters.
     */
    if (hay.length < 2) continue;

    if (hay === needle) return i;
    if (starts < 0 && (hay.startsWith(needle) || (hay.length >= 3 && needle.startsWith(hay)))) {
      starts = i;
    }
    if (contains < 0 && (hay.includes(needle) || (needle.includes(hay) && hay.length >= 4))) {
      contains = i;
    }

    const score = editDistance(needle, hay);
    if (score < bestScore) { bestScore = score; best = i; }
  }

  if (starts >= 0) return starts;
  if (contains >= 0 && needle.length >= 4) return contains;

  const tolerance = needle.length <= 5 ? 1 : 2;
  return bestScore <= tolerance ? best : -1;
}

/* --------------------------------------------------------------- polarity -- */

/** Quality words. Magnitude words ("highest", "most", "top") are deliberately
 *  absent: those state a direction outright and need no interpretation. */
const WORST = /\b(worst|slowest|longest|poorest|weakest|laggard|worst[- ]performing)\b/i;
const BEST = /\b(best|fastest|quickest|shortest|strongest|best[- ]performing)\b/i;

const FLIP = { asc: 'desc', desc: 'asc' };

/**
 * Resolves "worst" and "best" against the measure's own polarity.
 *
 * `order` is only a direction, and which end of a ranking is the bad one depends
 * on what is being ranked: for turnaround the slowest is worst, for FTFR the
 * lowest is. Models reliably read "worst" as one fixed direction, which answered
 * "which district has the worst closure TAT" with the three *fastest* districts.
 *
 * Only fires on a quality word, so "highest average resolution" is left alone.
 */
export function applyPolarity(spec, question) {
  const worstOrder = MEASURES[spec?.measure]?.worstOrder;
  if (!worstOrder || !question) return spec;
  if (WORST.test(question)) return { ...spec, order: worstOrder };
  if (BEST.test(question)) return { ...spec, order: FLIP[worstOrder] };
  return spec;
}

/**
 * "Penalty" on its own means money.
 *
 * There are three penalty measures — a count of breaching calls, the rupees
 * accruing per day, and the rupees settled on closure — and the model reaches
 * for the count, because `penalty` is the shortest name in the list. So "which
 * district has the highest penalty" came back as "Thiruvananthapuram, 11", which
 * is a number of calls presented where a figure in rupees was asked for. The
 * business asks this question about cost; a call count is what you get when you
 * ask for penalty *calls*.
 *
 * Corrected here rather than by asking the model more nicely, for the same
 * reason as `applyPolarity`: a convention this specific is not something to
 * re-litigate with a language model on every turn.
 *
 * Two things hold it back. A question that names the count keeps the count —
 * that is the "if I specify then ok" case. And a contract with no rate card
 * keeps it too: Andhra has none, and swapping the measure there turns a real
 * answer into "no rate card, this cannot be calculated".
 */
const COUNTS = new RegExp([
  'how many', 'no\\.? of', 'number of', '\\bcount\\b',
  '\\bcalls?\\b', '\\btickets?\\b', '\\bcases?\\b', '\\bjobs?\\b',
  // The question is often asked in the language it is thought in.
  'എത്ര', 'കോള', 'कितने', 'एत्रे', 'எத்தனை', 'ఎన్ని', 'ಎಷ್ಟು',
].join('|'), 'i');

/** Closure is the other money measure — settled rather than accruing. */
const CLOSURE = /closur|closed|settl|\bpaid\b|recover/i;

export function resolvePenaltyMeasure(spec, question, hasRateCard) {
  if (spec?.measure !== 'penalty' || !question || !hasRateCard) return spec;
  if (COUNTS.test(question)) return spec;
  return { ...spec, measure: CLOSURE.test(question) ? 'closurePenalty' : 'perDayPenalty' };
}

/**
 * A "why" question needs a breakdown, or it just restates the number.
 *
 * "What is causing Aswin to have this much penalty" came back as a refusal until
 * the prompt said otherwise, and then as a query with no dimension — which
 * computes Aswin's total and answers "₹5,550/day", the figure that prompted the
 * question. An explanation is the same measure, narrowed to the subject, split
 * by something that varies underneath it.
 *
 * Equipment is the default split because it is the thing a service manager acts
 * on: one analyser waiting on a spare is a different problem from twenty
 * scattered calls. The model's own choice wins whenever it made one.
 */
const WHY = /\bwhy\b|what(?:'s| is| are)?\s+(?:causing|driving|behind)|reason|because of|due to/i;

/*
 * "Summary" means the whole picture, not one number and not an essay.
 *
 * Asked "give a summary about the Kerala project" the model answered in prose —
 * a true paragraph about what the contract *is*, containing no figures at all.
 * Asked again "share overall summary with values" it picked a single measure and
 * answered with total calls. Both are reasonable readings of an ambiguous word
 * and neither is what anybody means, so the word is resolved here rather than
 * argued with on every turn.
 */
export const SUMMARY_WORDS = new RegExp([
  'summar(y|ies|ise|ize|ising|izing)', 'overview', 'overall',
  'how (are|is) (we|it|things|the contract|the project)',
  'full picture', 'brief me', 'tell me about',
  // The five other languages the panel speaks.
  'സംഗ്രഹം', 'സംക്ഷിപ്ത', 'సారాంశం', 'சுருக்கம்', 'ಸಾರಾಂಶ', 'सारांश',
].join('|'), 'i');

/**
 * Forces the overview measure when the question asks for one.
 *
 * Left alone when the question also names a specific measure — "summary of
 * penalty by district" is a ranking somebody asked for, and replacing it with
 * eight unrelated figures would be the same failure in the other direction.
 */
export function resolveSummary(spec, question) {
  if (!question || !SUMMARY_WORDS.test(question)) return spec;
  if (spec?.dimension && spec.dimension !== 'none') return spec;
  return { ...spec, measure: 'overview', dimension: 'none' };
}

export function explainWhy(spec, question) {
  if (!question || !WHY.test(question)) return spec;
  if (spec?.dimension && spec.dimension !== 'none') return spec;
  return { ...spec, dimension: 'equipment' };
}

/**
 * Dimensions `filterRows` narrows by itself, so the whole pass sees the filter
 * rather than it being applied to the result afterwards. Mirrors `FILTERABLE`
 * in query.js; anything absent here still works, just after the fact.
 */
const ENGINE_FILTERS = new Set([
  'zone', 'district', 'facilityName', 'facilityType', 'equipment', 'equipmentType',
  'manufacturer', 'engineer', 'department',
]);

/* ---------------------------------------------------------------- runner --- */

/**
 * Executes a spec against the dataset and returns everything needed to render
 * an answer — the figure, the ranked breakdown, and a plain-English sentence.
 */
/**
 * Every headline figure for a row set, in the order a service review reads them.
 *
 * Deliberately the same computations the KPI tiles use, from the same module —
 * a second implementation here would drift, and the whole reason the model never
 * sees ticket data is so the sentence and the tiles cannot disagree.
 *
 * FTFR takes the settled cutoff for the same reason the tile does: a call logged
 * yesterday still has today to be fixed in, and counting it as a miss reports an
 * unfinished figure as a low one.
 */
function overviewOf(ds, idx, referenceDay, ctx) {
  const through = ftfrSettledThrough(referenceDay, maxResolvedDay(ds));
  const s = summarize(ds, idx, referenceDay, { ftfrThrough: through });
  const repeats = analyzeRepeats(ds, idx);

  const pct = (n) => (s.total ? `${((n / s.total) * 100).toFixed(1)}%` : '—');
  const out = [
    { key: 'total', label: 'Total calls', display: int(s.total) },
    { key: 'open', label: 'Open', display: `${int(s.open)} (${pct(s.open)})` },
    { key: 'parked', label: 'Unresolved', display: `${int(s.parked)} (${pct(s.parked)})` },
    { key: 'resolved', label: 'Resolved', display: `${int(s.resolved)} (${pct(s.resolved)})` },
    { key: 'penalty', label: 'Penalty calls', display: int(s.penalty), value: s.penalty },
    { key: 'ftfr', label: 'FTFR', display: `${s.ftfrPct.toFixed(1)}%` },
    { key: 'tat', label: 'Avg resolution', display: `${s.avgResolutionDays.toFixed(1)} d` },
    { key: 'repeats', label: 'Repeat calls', display: int(repeats.followUps) },
  ];

  // Only where there is a rate card. Andhra has none, and a confident ₹0 is
  // worse than the figure simply not being there.
  if (ds.meta.penaltyRates) {
    const rows = accruingRows(ds, ctx.undatedIdx, ctx.dayFrom, ctx.dayTo);
    const perDay = rows.reduce((sum, i) => sum + ds.cols.dayRate[i], 0);
    out.push({ key: 'perDay', label: 'Per-day penalty', display: `${inr(perDay)}/day`, value: perDay });
  }

  return out;
}

export function runQuery(ds, filters, referenceDay, rawSpec) {
  const spec = {
    measure: 'calls',
    dimension: 'none',
    order: 'desc',
    limit: 8,
    range: 'current',
    filterDimension: 'none',
    filterValue: '',
    ...rawSpec,
  };

  const measure = MEASURES[spec.measure];
  if (!measure) throw new Error(`I don't know how to measure "${spec.measure}".`);
  if (measure.needsRateCard && !ds.meta.penaltyRates) {
    throw new Error(
      `${ds.meta.name} has no penalty rate card, so ${measureName(measure)} cannot be calculated.`,
    );
  }

  /*
   * Window precedence, most specific first: explicit dates, then a month count,
   * then a preset. Named dates used to have no slot at all, so "from 01-01-26 to
   * 23-07-26" fell through to a preset and answered for the wrong period.
   */
  const { minDay, maxDay } = ds.meta.dateRange;
  let effective = filters;
  let window = null;
  let explicitDates = false;

  const from = parseISODay(spec.fromDate);
  const to = parseISODay(spec.toDate);
  if (from != null || to != null) {
    // A start with no end means "to date", which is the newest day in the export.
    window = [from ?? minDay, to ?? maxDay];
    explicitDates = true;
  } else if (Number.isFinite(spec.lastMonths) && spec.lastMonths > 0) {
    window = [monthsBackStart(maxDay, spec.lastMonths), maxDay];
  } else if (RANGES[spec.range]) {
    window = RANGES[spec.range](ds.meta.dateRange);
  }

  if (window) {
    // Clamped, so a date before the contract started reports the contract's own
    // start rather than a period the data cannot speak to.
    effective = {
      ...filters,
      dayFrom: Math.min(Math.max(window[0], minDay), maxDay),
      dayTo: Math.max(Math.min(window[1], maxDay), minDay),
    };
    if (effective.dayFrom > effective.dayTo) {
      throw new Error('That start date is after the end date.');
    }
  }

  // An explicit filter from the question narrows it further.
  let appliedFilter = null;
  const filterCol = DIMENSIONS[spec.filterDimension];
  if (filterCol && spec.filterValue) {
    const id = matchDictionary(ds.dict[filterCol], spec.filterValue);
    if (id < 0) {
      throw new Error(`I couldn't find "${spec.filterValue}" in ${spec.filterDimension}.`);
    }
    /*
     * Through `dimensionLabel`, like every other engineer label on the page.
     * The raw value is `CYR181 - Aswin Ramachandran - 8301012759`, so without
     * this the answer names a code and a mobile number — and the voice output
     * reads the number out digit by digit.
     */
    appliedFilter = {
      dimension: spec.filterDimension,
      label: dimensionLabel(spec.filterDimension, ds.dict[filterCol][id]),
    };
    /*
     * Anything `filterRows` knows how to narrow by goes through the engine;
     * the rest is filtered after the fact. Zone belongs in the first group — the
     * question that exposed this, "which engineer in north zone has the highest
     * penalty", could not be answered at all while zone was not a dimension.
     */
    if (ENGINE_FILTERS.has(filterCol)) {
      effective = { ...effective, [filterCol]: new Set([id]) };
    } else {
      appliedFilter.postFilter = { col: filterCol, id };
    }
  }

  const idx = filterRows(ds, effective);
  const ctx = {
    referenceDay,
    dayFrom: effective.dayFrom,
    dayTo: effective.dayTo,
    undatedIdx: filterRows(ds, effective, { dateField: null }),
    closedIdx: filterRows(ds, effective, { dateField: 'resolvedDay' }),
  };

  /*
   * A summary is a different shape of answer, not a measure with a dimension,
   * so it returns before any of the ranking machinery below.
   *
   * It reads the same filtered rows as everything else, which is what makes
   * "tell me about South zone" work without a line of its own: the zone filter
   * has already narrowed `idx` by the time this runs.
   */
  if (measure.kind === 'overview') {
    // A dimension the engine cannot narrow by is applied after the fact, the
    // same way the ranked path does it below.
    const scoped = appliedFilter?.postFilter
      ? idx.filter((i) => ds.cols[appliedFilter.postFilter.col][i] === appliedFilter.postFilter.id)
      : idx;
    return {
      spec, measure, appliedFilter, effective,
      headline: null,
      items: [],
      overview: overviewOf(ds, scoped, referenceDay, ctx),
      total: summarize(ds, scoped, referenceDay).total,
    };
  }

  let rows = measure.rows(ds, idx, ctx);
  if (appliedFilter?.postFilter) {
    const { col, id } = appliedFilter.postFilter;
    rows = Array.from(rows).filter((i) => ds.cols[col][i] === id);
  }

  /*
   * Breaking down by the very dimension being filtered leaves one group, and the
   * sentence reads "Thiruvananthapuram has the highest open calls in
   * Thiruvananthapuram". A single figure says the same thing properly.
   */
  const dimCol = DIMENSIONS[spec.dimension] === filterCol ? null : DIMENSIONS[spec.dimension];
  const summaryOfAll = summarize(ds, idx, referenceDay);

  // A single overall figure.
  if (!dimCol) {
    const total = measure.kind === 'count'
      ? rows.length
      : rows.reduce((sum, i) => sum + measure.valueOf(ds, i), 0);
    const value = (measure.kind === 'rate' || measure.kind === 'mean')
      ? (rows.length ? total / rows.length : 0)
      : total;

    return {
      spec, measure, appliedFilter, effective,
      headline: { value, display: measure.format(value), sampleSize: rows.length },
      items: [],
      total: summaryOfAll.total,
    };
  }

  // A ranked breakdown.
  const limit = Math.max(1, Math.min(25, Number(spec.limit) || 8));
  let items;

  if (measure.kind === 'count') {
    items = topN(countBy(ds, rows, dimCol), ds.dict[dimCol], limit * 3)
      .filter((it) => it.id >= 0);
  } else {
    const groups = [...aggregateBy(ds, rows, dimCol, (i) => measure.valueOf(ds, i)).entries()]
      .filter(([id]) => id >= 0)
      .filter(([, g]) => g.n >= (measure.minSamples ?? 1))
      .map(([id, g]) => {
        const v = (measure.kind === 'sum') ? g.sum : g.sum / g.n;
        return { id, label: ds.dict[dimCol][id], value: v, n: g.n };
      });
    items = groups;
  }

  items.sort((a, b) => (spec.order === 'asc' ? a.value - b.value : b.value - a.value));
  const groupCount = items.length;
  items = items.slice(0, limit).map((it) => ({
    ...it,
    label: dimensionLabel(spec.dimension, it.label),
    display: measure.format(it.value),
    sub: it.n != null ? `${int(it.n)} calls` : undefined,
  }));

  return {
    spec, measure, appliedFilter, effective,
    headline: null,
    items,
    groupCount,
    total: summaryOfAll.total,
  };
}

/**
 * Composes the answer sentence locally rather than letting the model write it.
 * The model never sees these figures, so anything it wrote about them would be
 * invented; this way the sentence and the chart cannot disagree.
 */
export function describeResult(ds, result) {
  const { measure, spec, items, headline, appliedFilter, effective } = result;
  const where = appliedFilter ? ` in ${appliedFilter.label}` : '';
  const contract = ds.meta.name;

  // Name the window whenever it is not simply what the dashboard already shows, so
  // it is obvious the figure was recomputed for the period asked about.
  const asked = Boolean(spec.fromDate || spec.toDate)
    || (Number.isFinite(spec.lastMonths) && spec.lastMonths > 0)
    || (spec.range && spec.range !== 'current');
  const period = asked
    ? ` from ${formatDay(effective.dayFrom)} to ${formatDay(effective.dayTo)}`
    : '';

  /*
   * A summary reads as a sentence, not as a list of labels — the figures are
   * drawn beside it anyway, and repeating them in the same order with the same
   * words would be the same thing said twice.
   */
  if (result.overview) {
    const cell = (key) => result.overview.find((o) => o.key === key);
    const at = (key) => cell(key)?.display ?? '—';
    const scope = appliedFilter ? appliedFilter.label : contract;
    const money = cell('perDay');

    // "1 calls are past SLA" is the kind of thing that makes a whole answer look
    // machine-written, so the one figure the sentence counts out loud agrees.
    const breached = cell('penalty')?.value ?? 0;
    const sla = breached === 1 ? '1 call is past SLA' : `${at('penalty')} calls are past SLA`;

    return `${scope}${period}: ${at('total')} calls logged, ${at('open')} still open and `
      + `${at('parked')} unresolved. First time fix rate is ${at('ftfr')} and calls take `
      + `${at('tat')} on average to close. ${sla}`
      + `${money && money.value > 0 ? `, costing ${money.display}` : ''}.`;
  }

  if (headline) {
    const size = measure.kind === 'rate' || measure.kind === 'mean'
      ? ` across ${int(headline.sampleSize)} resolved calls`
      : '';
    return `${measure.label}${where} for ${contract}${period} is ${headline.display}${size}.`;
  }

  if (!items.length) {
    return `No ${measureName(measure)} data${where} for ${contract}${period}.`;
  }

  const [singular, plural] = DIM_NOUN[spec.dimension] ?? [spec.dimension, `${spec.dimension}s`];
  const best = items[0];
  const superlative = spec.order === 'asc' ? 'lowest' : 'highest';
  const rest = items.slice(1, 3)
    .map((it) => `${it.label} at ${it.display}`)
    .join(', ');

  const total = result.groupCount ?? items.length;
  const scope = total > items.length
    ? `Top ${items.length} of ${int(total)} ${plural}.`
    : `Across ${total} ${total === 1 ? singular : plural}.`;

  return `${best.label} has the ${superlative} ${measureName(measure)}${where} `
    + `for ${contract}${period} at ${best.display}`
    + (rest ? `, followed by ${rest}` : '')
    + `. ${scope}`;
}
