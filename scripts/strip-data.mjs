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
/*
 * dist/bemmp/data, which is where vite.config.js puts it.
 *
 * This said dist/data, and had done since before outDir moved to
 * dist/bemmp. The failure was silent and it was the worst kind: the
 * script's entire job is to leave a data-free bundle safe to host
 * publicly, and it was deleting a directory that no longer exists while
 * 42 MB of ticket data sat one level down, untouched, and it reported
 * success either way. "dist/data not present; nothing to strip" reads
 * like a clean bill of health.
 *
 * So it now refuses rather than reassures: if the directory is missing
 * it exits non-zero, because a strip that finds nothing to strip means
 * either the build has moved again or it was never run, and both of
 * those should stop a release rather than pass it.
 */
const DATA = path.join(ROOT, 'dist', 'bemmp', 'data');

if (fs.existsSync(DATA)) {
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('stripped dist/bemmp/data — bundle now ships no ticket data');
} else {
  console.error(
    `${DATA} does not exist.\n`
    + 'Either the build has not run or its output has moved again. Refusing to\n'
    + 'report a data-free bundle without having removed anything.',
  );
  process.exit(1);
}

const size = fs.existsSync(path.join(ROOT, 'dist'))
  ? fs.readdirSync(path.join(ROOT, 'dist'), { recursive: true })
    .map((f) => path.join(ROOT, 'dist', f))
    .filter((f) => fs.statSync(f).isFile())
    .reduce((n, f) => n + fs.statSync(f).size, 0)
  : 0;
console.log(`dist/ is now ${(size / 1024).toFixed(0)} KB`);
