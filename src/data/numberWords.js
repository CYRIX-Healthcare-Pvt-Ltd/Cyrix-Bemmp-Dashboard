/**
 * Spells figures out as English words, for the text handed to the voice.
 *
 * Writing digits as 0-9 is not enough: a Malayalam-speaking voice still reads "79.8"
 * as Malayalam words. Instructions asking it not to are only a request. Replacing
 * the digits with English words before the text is spoken makes it certain — the
 * voice reads English words in English however the surrounding sentence is set.
 *
 * Only the spoken copy goes through this. The text on screen keeps its digits.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];

/** 0-999 in words. */
function underThousand(n) {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const rest = n % 10;
    return rest ? `${tens} ${ONES[rest]}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${hundreds} ${underThousand(rest)}` : hundreds;
}

/**
 * Indian grouping — crore and lakh, not million and billion. The figures come from
 * an Indian service contract and are read to Indian managers.
 */
export function numberToWords(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (n === 0) return 'zero';

  const parts = [];
  let rest = Math.floor(n);

  const crore = Math.floor(rest / 10000000);
  if (crore) { parts.push(`${numberToWords(crore)} crore`); rest %= 10000000; }

  const lakh = Math.floor(rest / 100000);
  if (lakh) { parts.push(`${underThousand(lakh)} lakh`); rest %= 100000; }

  const thousand = Math.floor(rest / 1000);
  if (thousand) { parts.push(`${underThousand(thousand)} thousand`); rest %= 1000; }

  if (rest) parts.push(underThousand(rest));
  return parts.join(' ');
}

/** Decimals are read digit by digit, the way a person reads 79.8 aloud. */
function decimalToWords(fraction) {
  return [...fraction].map((d) => ONES[Number(d)]).join(' ');
}

function figureToWords(raw) {
  const clean = raw.replace(/,/g, '');
  const [whole, fraction] = clean.split('.');
  const words = numberToWords(Number(whole));
  return fraction ? `${words} point ${decimalToWords(fraction)}` : words;
}

/*
 * Matches an optional rupee sign, the figure, and an optional unit. The `d`
 * suffix is the dashboard's shorthand for days ("2.0 d") and would otherwise be
 * spoken as the letter.
 */
const FIGURE = /(₹\s?)?(\d[\d,]*(?:\.\d+)?)(\s?%|\s?d\b)?/g;

/**
 * Dates already read well as they are — "01 May 2026". Sending them through the
 * figure rule turns them into "one May two thousand twenty six", so they are set
 * aside first and put back at the end.
 */
const DATE = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/g;

// Markers are letters between guillemets: no digits, so the figure rule cannot
// match them and spell the marker itself out.
const MARK_OPEN = '«';
const MARK_CLOSE = '»';
const RESTORE = /«([A-Z])»/g;

export function spellNumbersForSpeech(text) {
  if (!text) return text;

  const dates = [];
  let masked = text.replace(DATE, (d) => {
    dates.push(d);
    return `${MARK_OPEN}${String.fromCharCode(65 + dates.length - 1)}${MARK_CLOSE}`;
  });

  // "₹1,39,900/day" reads better as "... rupees per day" than with the slash.
  masked = masked.replace(/\/\s?day\b/gi, ' per day');

  masked = masked.replace(FIGURE, (match, rupee, digits, unit) => {
    const isDays = unit && unit.trim() === 'd';
    // "2.0 d" is two days, not "two point zero days".
    const cleaned = isDays ? digits.replace(/\.0+$/, '') : digits;
    const words = figureToWords(cleaned);

    if (rupee) return `${words} rupees`;
    if (unit && unit.trim() === '%') return `${words} percent`;
    if (isDays) {
      return `${words} ${Number(cleaned.replace(/,/g, '')) === 1 ? 'day' : 'days'}`;
    }
    return words;
  });

  return masked.replace(RESTORE, (m, letter) => dates[letter.charCodeAt(0) - 65] ?? m);
}
