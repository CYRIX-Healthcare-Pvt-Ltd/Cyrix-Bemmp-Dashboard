/**
 * Extracts district outlines for the contracted states into a compact SVG module.
 *
 * Source: geoBoundaries ADM2 for India (gbOpen, 2021), Open Database License 1.0.
 * https://www.geoboundaries.org — attribution is carried in the generated file and
 * rendered in the dashboard footer.
 *
 * Run once, or again when a state is added:  node scripts/build-maps.mjs
 * Output: src/data/maps/<stateId>.js
 *
 * The whole-India file is ~10 MB; only the districts of the states below are kept,
 * reprojected into a 1000-unit viewBox and rounded, which lands each state at a few
 * tens of KB — small enough to ship in the bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'data', 'maps');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'geoboundaries-ind-adm2.json');

const SOURCE = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM2/geoBoundaries-IND-ADM2_simplified.geojson';

/**
 * Districts are chosen by matching the source against the names in the state's own
 * artifact, not by bounding box — a box around Kerala also catches Coimbatore and
 * Mysore. Matching on the data's own vocabulary keeps the map to the contract and
 * gives the map-to-data join for free.
 */
const STATES = [
  { id: 'kl', name: 'Kerala', bbox: [74.7, 8.1, 77.5, 12.9] },
  { id: 'ap', name: 'Andhra Pradesh', bbox: [76.6, 12.5, 85.0, 19.95] },
];

/** Normalised for comparison: case, punctuation and bracketed suffixes dropped. */
const normalizeName = (s) => String(s)
  .toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/[^a-z]/g, '');

/** Small edit distance, to absorb spelling drift like Kasargode vs Kasaragod. */
function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Finds the dataset district a source feature belongs to.
 *
 * Exact match first, then containment (the source calls Nellore "Sri Potti
 * Sriramulu Nellore"), then a tight edit distance. Anything looser starts pairing
 * unrelated districts.
 */
function matchDistrict(sourceName, districts) {
  const needle = normalizeName(sourceName);
  if (!needle) return null;

  const exact = districts.find((d) => d.key === needle);
  if (exact) return exact;

  const contained = districts.find((d) => needle.includes(d.key) || d.key.includes(needle));
  if (contained && Math.min(contained.key.length, needle.length) >= 5) return contained;

  let best = null;
  let bestScore = Infinity;
  for (const d of districts) {
    const score = editDistance(needle, d.key);
    if (score < bestScore) { bestScore = score; best = d; }
  }
  return bestScore <= 2 ? best : null;
}

const VIEW = 1000; // longest side of the output viewBox

async function loadIndia() {
  if (fs.existsSync(CACHE)) {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  }
  process.stdout.write('downloading geoBoundaries IND ADM2 (simplified)... ');
  const r = await fetch(SOURCE, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const text = await r.text();
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, text);
  console.log(`${(text.length / 1e6).toFixed(1)} MB`);
  return JSON.parse(text);
}

/** Every ring of a Polygon or MultiPolygon, as flat coordinate arrays. */
function ringsOf(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function centroidOf(rings) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const ring of rings) {
    for (const [lon, lat] of ring) { x += lon; y += lat; n++; }
  }
  return n ? [x / n, y / n] : [0, 0];
}

const inBox = ([lon, lat], [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n;

/** The district names this state's artifact actually uses. */
function datasetDistricts(stateId) {
  const meta = path.join(ROOT, 'public', 'data', stateId, 'meta.json');
  if (!fs.existsSync(meta)) throw new Error(`run build:data first; missing ${meta}`);
  const { dictionaries } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return dictionaries.district.map((name) => ({ name, key: normalizeName(name) }));
}

/**
 * Perpendicular-distance simplification. The source is already simplified for the
 * whole country; this trims it again for a decorative backdrop, where a few metres
 * of coastline detail cost bytes and buy nothing.
 */
function simplify(points, tolerance) {
  if (points.length < 3) return points;

  const sqTol = tolerance * tolerance;
  const sqSegDist = ([px, py], [ax, ay], [bx, by]) => {
    let dx = bx - ax;
    let dy = by - ay;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
      if (t > 1) return (px - bx) ** 2 + (py - by) ** 2;
      if (t > 0) { dx = px - (ax + dx * t); dy = py - (ay + dy * t); return dx * dx + dy * dy; }
    }
    return (px - ax) ** 2 + (py - ay) ** 2;
  };

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > sqTol && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function buildState(state, features) {
  const wanted = datasetDistricts(state.id);
  const byData = new Map(); // dataset district name -> merged rings

  for (const f of features) {
    const rings = ringsOf(f.geometry);
    if (!rings.length) continue;
    // Both filters are needed. The box alone also catches Coimbatore and Mysore;
    // the name alone matches same-sounding districts anywhere in India — Kanker in
    // Chhattisgarh is two edits from Kannur — and merging those scatters the map
    // across half the country.
    if (!inBox(centroidOf(rings), state.bbox)) continue;
    const hit = matchDistrict(f.properties.shapeName, wanted);
    if (!hit) continue;
    // Several source districts can map to one dataset district after a
    // reorganisation; their rings simply merge into the same shape.
    if (!byData.has(hit.name)) byData.set(hit.name, []);
    byData.get(hit.name).push(...rings);
  }

  const districts = [...byData.entries()].map(([name, rings]) => ({ name, rings }));
  const missing = wanted.filter((d) => !byData.has(d.name)).map((d) => d.name);
  if (!districts.length) throw new Error(`no districts matched for ${state.name}`);

  // One projection for the whole state, so the districts stay aligned to each other.
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const d of districts) {
    for (const ring of d.rings) {
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
  }

  // Equirectangular, with longitude squeezed by cos(latitude) so the state is not
  // stretched sideways. Fine at this scale and far simpler than a real projection.
  const midLat = ((north + south) / 2) * (Math.PI / 180);
  const lonScale = Math.cos(midLat);
  const spanX = (east - west) * lonScale;
  const spanY = north - south;
  const scale = VIEW / Math.max(spanX, spanY);
  const width = Math.round(spanX * scale);
  const height = Math.round(spanY * scale);

  const project = ([lon, lat]) => [
    +(((lon - west) * lonScale) * scale).toFixed(1),
    // SVG y grows downward; latitude grows upward.
    +((north - lat) * scale).toFixed(1),
  ];

  const out = districts.map((d) => {
    const paths = d.rings
      .map((ring) => simplify(ring.map(project), 1.2))
      .filter((ring) => ring.length > 3)
      .map((ring) => `M${ring.map(([x, y]) => `${x},${y}`).join('L')}Z`)
      .join('');
    return { name: d.name, path: paths };
  }).filter((d) => d.path);

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { width, height, districts: out, missing, wanted: wanted.length };
}

async function main() {
  const india = await loadIndia();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const state of STATES) {
    const { width, height, districts, missing, wanted } = buildState(state, india.features);

    /*
     * A partly-drawn state looks broken rather than atmospheric. Andhra Pradesh
     * reorganised into 26 districts in 2022 and the source is 2021, so most of its
     * new names have no boundary here; better to ship nothing and let the ambient
     * layer carry that contract than to draw half a state.
     */
    const coverage = districts.length / wanted;
    if (coverage < 0.9) {
      console.log(
        `${state.id}: SKIPPED — only ${districts.length}/${wanted} districts matched `
        + `(${Math.round(coverage * 100)}%)`,
      );
      console.log(`   unmatched: ${missing.join(', ')}`);
      const stale = path.join(OUT_DIR, `${state.id}.js`);
      if (fs.existsSync(stale)) fs.rmSync(stale);
      continue;
    }

    const body = `/**
 * ${state.name} district outlines, generated by scripts/build-maps.mjs.
 *
 * Source: geoBoundaries ADM2 India (gbOpen, 2021), Open Database License 1.0.
 * https://www.geoboundaries.org — do not hand-edit; regenerate instead.
 */
export const VIEW_BOX = '0 0 ${width} ${height}';

export const DISTRICTS = ${JSON.stringify(districts, null, 0)};
`;
    const file = path.join(OUT_DIR, `${state.id}.js`);
    fs.writeFileSync(file, body);
    console.log(
      `${state.id}: matched ${districts.length}/${wanted} districts, ${width}x${height}, `
      + `${(body.length / 1024).toFixed(0)} KB`,
    );
    console.log(`   ${districts.map((d) => d.name).join(', ')}`);
    if (missing.length) console.log(`   UNMATCHED: ${missing.join(', ')}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
