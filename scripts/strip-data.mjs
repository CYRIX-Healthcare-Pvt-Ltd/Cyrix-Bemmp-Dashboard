/**
 * Removes the prebuilt artifacts from dist/, leaving a data-free static bundle.
 *
 * That is what makes a public host safe: the site ships only code, and each user
 * supplies their own TM export through the Data panel, which is parsed in their
 * browser and never leaves their machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'dist', 'data');

if (fs.existsSync(DATA)) {
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('stripped dist/data — bundle now ships no ticket data');
} else {
  console.log('dist/data not present; nothing to strip');
}

const size = fs.existsSync(path.join(ROOT, 'dist'))
  ? fs.readdirSync(path.join(ROOT, 'dist'), { recursive: true })
    .map((f) => path.join(ROOT, 'dist', f))
    .filter((f) => fs.statSync(f).isFile())
    .reduce((n, f) => n + fs.statSync(f).size, 0)
  : 0;
console.log(`dist/ is now ${(size / 1024).toFixed(0)} KB`);
