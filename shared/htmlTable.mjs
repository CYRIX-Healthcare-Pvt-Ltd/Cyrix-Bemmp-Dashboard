/**
 * Reading a "spreadsheet" that is a web page.
 *
 * Uttar Pradesh's TM export is saved as .xls but is an HTML table — the old
 * trick of a server writing `<table>` markup under an Excel name, which Excel
 * opens without complaint. There is no zip and no sheet XML in it, so the
 * workbook reader has nothing to read; this reads the table.
 *
 * Deliberately small: one table, rows of `<th>`/`<td>` cells, text only. The
 * export has no merged or nested cells, and a structure it does not have is
 * not guessed at.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** True when the start of a file is markup rather than a zip — the web-page kind of .xls. */
export const looksLikeHtml = (head) => /^\s*(<!doctype|<html|<head|<style|<div|<table|<meta)/i.test(head);

/**
 * The rows of a page's table, each an array of cell texts, the heading row first.
 *
 * Every cell keeps its place: an empty one written `<td/>` counts as a blank
 * cell, and one spanning columns (`colspan`) fills them all. Skipping either
 * slid every later cell of the row one column over, under the wrong heading
 * — the heading row itself stayed right, so nothing noticed (24 Sep).
 */
export function htmlTableRows(html) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t([hd])\b([^>]*?)(?:\/>|>([\s\S]*?)<\/t\1>)/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const cells = [];
    cellRe.lastIndex = 0;
    let cell;
    while ((cell = cellRe.exec(row[1])) !== null) {
      const text = cell[3] === undefined ? ''
        : decode(cell[3].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(cell[2])?.[1] ?? 1);
      cells.push(text);
      for (let i = 1; i < Math.min(span, 50); i++) cells.push('');
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** A column's letter from its position: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * A day written out — 22/09/2026, 22/09/2026 02:20:26 PM, 2026-09-22 — as an
 * Excel serial, which is how the rest of the dataset keeps days. '' when the
 * cell is blank or is not a day.
 */
export function excelDayOfText(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  let y;
  let m;
  let d;
  let hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(s);
  if (hit) {
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else {
    hit = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
    if (!hit) return '';
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return Date.UTC(y, m - 1, d) / 86400000 + 25569;
}
