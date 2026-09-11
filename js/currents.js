/* Atlas of the Curious — the ocean's currents.

   The sea used to be three traveling sine trains crossing the whole map in the
   same direction. A real ocean does not do that: it turns. Five subtropical
   gyres wheel between the trade winds and the westerlies, two subpolar gyres
   turn the other way, a handful of narrow western boundary jets (the Gulf
   Stream, the Kuroshio, the Brazil, the Agulhas, the East Australian) run warm
   water poleward at several times the speed of the water beside them, and the
   Antarctic Circumpolar Current closes the whole system in one unbroken
   eastward band.

   That is what this module is: a small table of those features in lat/lon, a
   sampler that sums them into one velocity at any point — including points
   *outside* the world grid, which is what the open ocean around the map is
   made of — and a builder that freezes the sampler into the flat typed arrays
   js/map.js's animation loop can read without a single allocation per frame.

   Three ideas hold it together:

   1. Everything is a sum of smooth kernels. A gyre is a vortex whose speed is
      zero at its centre, peaks at its rim and decays outward; a jet is a
      Gaussian ridge along a polyline; a band is a Gaussian in latitude. Sums of
      smooth things are smooth, so neighbouring cells never disagree about which
      way the water is going and the glyph field reads as flow rather than as
      noise.

   2. Degrees are the working unit, and on this map they are very nearly
      isotropic on screen: the desktop grid is 150 × 39 cells over 360° × 180°,
      so one degree of longitude and one degree of latitude are within a few
      percent of the same number of pixels. That is why a distance in degrees
      can be compared with a distance in degrees without a projection factor.

   3. The margin is the same ocean. A cell west of column 0 is not empty space,
      it is the Pacific seen past the antimeridian, so longitude wraps; a cell
      above row 0 is over the North Pole and down the far side, so the chart
      folds and the north-south component of the flow changes sign. Both are
      exact continuations, which is why the currents cross the edges of the map
      without a seam — and the water is quietened as it goes so the margin never
      competes with the atlas. One sampler answers for the world grid and for the
      open ocean around it, which is what keeps them one body of water.

   Pure: no `document`, no `window`, no canvas. js/map.js builds the field once
   per map build and never calls back into here during a frame. */

// Longitude difference, folded into (-180, 180].
export function wrapLon(deg) {
  let d = (deg + 180) % 360;
  if (d < 0) d += 360;
  return d - 180;
}

/* ---- The table ---------------------------------------------------------- */

/* Gyres. `rx` / `ry` are half-widths in degrees of longitude / latitude — the
   rim, where the current is fastest. `spin` is +1 for a gyre that turns
   clockwise as the map is printed (north up) and -1 for one that turns
   counter-clockwise; the subtropical gyres are anticyclonic, so they are
   clockwise in the north and counter-clockwise in the south, and the two
   subpolar gyres turn the other way. `strength` is relative surface speed. */
export const GYRES = [
  { name: "North Atlantic subtropical", lat: 30, lon: -45, rx: 31, ry: 17, spin: 1, strength: 1.00 },
  { name: "South Atlantic subtropical", lat: -27, lon: -15, rx: 27, ry: 15, spin: -1, strength: 0.86 },
  { name: "North Pacific subtropical", lat: 31, lon: -175, rx: 48, ry: 18, spin: 1, strength: 1.00 },
  { name: "South Pacific subtropical", lat: -31, lon: -125, rx: 48, ry: 17, spin: -1, strength: 0.90 },
  { name: "Indian Ocean subtropical", lat: -28, lon: 74, rx: 32, ry: 15, spin: -1, strength: 0.88 },
  { name: "North Atlantic subpolar", lat: 57, lon: -35, rx: 20, ry: 9, spin: -1, strength: 0.52 },
  { name: "Alaska (North Pacific subpolar)", lat: 54, lon: -157, rx: 22, ry: 9, spin: -1, strength: 0.48 },
  { name: "Beaufort", lat: 76, lon: -145, rx: 22, ry: 7, spin: 1, strength: 0.34 },
  { name: "Weddell", lat: -67, lon: -40, rx: 18, ry: 6, spin: 1, strength: 0.36 }
];

/* Named boundary currents: narrow, fast, and following a coast. Each is a
   polyline in [lat, lon] and a Gaussian half-width in degrees, so the jet is a
   ridge of speed along the path that fades sideways into the gyre it belongs
   to. The four warm western boundary currents run poleward; the Humboldt is
   here as the cold eastern-boundary counterpart, because the Pacific looks
   wrong without it. */
export const JETS = [
  {
    name: "Gulf Stream", width: 4.2, strength: 1.55,
    path: [[25, -79], [31, -79], [36, -74], [40, -64], [45, -50], [50, -38]]
  },
  {
    name: "Kuroshio", width: 4.0, strength: 1.45,
    path: [[21, 121], [27, 128], [33, 138], [36, 146], [39, 158]]
  },
  {
    name: "Brazil", width: 4.0, strength: 1.00,
    path: [[-20, -38], [-27, -46], [-34, -52], [-39, -56]]
  },
  {
    name: "Agulhas", width: 3.8, strength: 1.20,
    path: [[-25, 35], [-31, 30], [-35, 24], [-38, 18]]
  },
  {
    name: "East Australian", width: 3.6, strength: 0.92,
    path: [[-23, 153], [-30, 154], [-36, 151], [-40, 149]]
  },
  {
    name: "Humboldt", width: 4.0, strength: 0.80,
    path: [[-42, -76], [-30, -73], [-18, -73], [-8, -80], [-3, -84]]
  }
];

/* Zonal bands: a Gaussian in latitude, all the way round the world. The
   circumpolar current is the strongest current on Earth and the only one that
   closes on itself; the trades and the westerlies are the wind-driven drift
   that fills in between the gyres (and, in the Arctic, where there is no gyre
   at all); the equatorial counter-current is the eastward seam that makes the
   doldrums read as a seam rather than as one wide westward sheet. */
export const BANDS = [
  { name: "Antarctic Circumpolar", lat: -57, width: 9, dir: 1, strength: 1.30 },
  { name: "North Equatorial Counter", lat: 6, width: 3.2, dir: 1, strength: 0.46 },
  { name: "North trade drift", lat: 15, width: 13, dir: -1, strength: 0.34 },
  { name: "South trade drift", lat: -15, width: 13, dir: -1, strength: 0.34 },
  { name: "North westerly drift", lat: 45, width: 11, dir: 1, strength: 0.30 },
  { name: "South westerly drift", lat: -44, width: 11, dir: 1, strength: 0.34 },
  { name: "Polar easterly drift", lat: 79, width: 11, dir: -1, strength: 0.22 }
];

// Beyond this many rim-radii a gyre contributes nothing worth the exp().
const GYRE_REACH = 3.2;
// Water within this many cells of a coast is slowed (friction, and the fact
// that a current cannot flow into a continent).
export const COAST_CELLS = 2.6;
/* Past a pole the chart folds: the cell above row 0 at longitude L is the
   physical point at latitude 180 - lat and longitude L + 180 — over the pole and
   down the far side — and a step *up* the chart there is a step *south* on the
   globe, so the north-south component of the flow changes sign. That fold is
   exact, which is why the currents cross the top and bottom edges of the map
   without a seam. It is also nonsense past a point, so the water is quietened as
   it goes: POLE_FADE degrees of e-folding down to POLE_FLOOR, enough that the
   polar margin reads as open water and not as a mirror. */
export const POLE_FADE = 14;
export const POLE_FLOOR = 0.5;
// How much of the coast damping a margin column keeps. The wrapped column is a
// real meridian, so its land mask is the right one to use — but there is no
// land painted out there, so a full stop would read as a stripe of dead water
// rather than as the lee of a continent just off the map.
const MARGIN_DAMP_FLOOR = 0.55;

/* ---- The sampler -------------------------------------------------------- */

/* The velocity at one point, in the table's own units: `u` east, `v` north.
   `out` is written in place so a grid sweep allocates nothing. */
export function flowAt(lat, lon, out) {
  let u = 0, v = 0;
  for (let g = 0; g < GYRES.length; g++) {
    const gy = GYRES[g];
    const ax = wrapLon(lon - gy.lon) / gy.rx;
    const ay = (lat - gy.lat) / gy.ry;
    const r = Math.sqrt(ax * ax + ay * ay);
    if (r > GYRE_REACH || r < 1e-6) continue;
    // Zero at the centre, one at the rim, decaying outward: the calm eye of a
    // gyre falls straight out of the profile rather than being special-cased.
    const prof = gy.strength * r * Math.exp(1 - r);
    const nx = ax / r, ny = ay / r;
    u += gy.spin * ny * prof;
    v += -gy.spin * nx * prof;
  }
  for (let j = 0; j < JETS.length; j++) {
    const jet = JETS[j];
    const path = jet.path;
    const inv = 1 / (jet.width * jet.width);
    for (let k = 0; k + 1 < path.length; k++) {
      const ay = lat - path[k][0];
      const ax = wrapLon(lon - path[k][1]);
      const by = path[k + 1][0] - path[k][0];
      const bx = wrapLon(path[k + 1][1] - path[k][1]);
      const len2 = bx * bx + by * by;
      if (len2 < 1e-9) continue;
      let t = (ax * bx + ay * by) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = ax - t * bx, dy = ay - t * by;
      const d2 = dx * dx + dy * dy;
      if (d2 * inv > 9) continue;              // > 3 half-widths away
      const w = jet.strength * Math.exp(-d2 * inv);
      const len = Math.sqrt(len2);
      u += w * bx / len;
      v += w * by / len;
    }
  }
  for (let b = 0; b < BANDS.length; b++) {
    const band = BANDS[b];
    const z = (lat - band.lat) / band.width;
    if (z * z > 9) continue;
    u += band.dir * band.strength * Math.exp(-z * z);
  }
  out.u = u;
  out.v = v;
  return out;
}

/* Distance from every water cell to the nearest land, in cells, as a damping
   factor in 0..1. Land itself is 0: nothing flows through a continent, and the
   check in scripts/checks/ocean.mjs holds this module to that. Columns wrap, so
   the antimeridian is not a false coast. */
export function coastDamping(land, cols, rows) {
  const n = cols * rows;
  const damp = new Float32Array(n);
  const dist = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (land && land[i]) { dist[i] = 0; queue[tail++] = i; }
  }
  const push = (row, col, d) => {
    if (row < 0 || row >= rows) return;
    const c = col < 0 ? col + cols : col >= cols ? col - cols : col;
    const i = row * cols + c;
    if (dist[i] >= 0) return;
    dist[i] = d;
    queue[tail++] = i;
  };
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    const row = (i / cols) | 0, col = i % cols;
    push(row, col - 1, d); push(row, col + 1, d);
    push(row - 1, col, d); push(row + 1, col, d);
  }
  for (let i = 0; i < n; i++) {
    if (land && land[i]) { damp[i] = 0; continue; }
    const d = dist[i] < 0 ? COAST_CELLS : dist[i];
    damp[i] = d >= COAST_CELLS ? 1 : d / COAST_CELLS;
  }
  return damp;
}

/* ---- Directions and glyphs ---------------------------------------------- */

/* Eight compass buckets plus one for water too slow to have a direction —
   the eye of a gyre, the doldrums, an enclosed sea. Bucket 0 is east and they
   run counter-clockwise on screen, which is how atan2 counts.

   Each bucket carries six glyphs, one per brightness level, so the *shape* of
   the water says which way it is going and the colour says how fast. Every one
   of them is ASCII or Latin-1 except `≈`, which the sea has always used: they
   are in the mono face, and they are all one cell wide. (The check measures
   that rather than trusting it — a glyph a hair wider than the cell would shear
   the whole character grid.) */
export const FLOW_FAMILIES = [
  { name: "east-west", glyphs: ["·", "·", ":", "-", "~", "≈"] },
  { name: "diagonal-up", glyphs: ["·", "·", ":", "/", "/", "/"] },
  { name: "north-south", glyphs: ["·", "·", ":", "|", "|", "|"] },
  { name: "diagonal-down", glyphs: ["·", "·", ":", "\\", "\\", "\\"] },
  { name: "eddy", glyphs: ["·", "·", ":", "·", "o", "o"] }
];
// bucket -> family: E and W share one, NE and SW the next, and so on; 8 is calm.
const BUCKET_FAMILY = [0, 1, 2, 3, 0, 1, 2, 3, 4];
export const FLOW_BUCKETS = BUCKET_FAMILY.length;
export const FLOW_LEVELS = 6;
/* One flat array of single characters, indexed `bucket * FLOW_LEVELS + level`.
   Flat and pre-split so a frame never indexes a string, builds a key or
   concatenates: the whole point of the table is that the animation loop does
   nothing but two array reads per cell. */
export const FLOW_GLYPHS = (function () {
  const out = new Array(FLOW_BUCKETS * FLOW_LEVELS);
  for (let b = 0; b < FLOW_BUCKETS; b++) {
    const fam = FLOW_FAMILIES[BUCKET_FAMILY[b]].glyphs;
    for (let l = 0; l < FLOW_LEVELS; l++) out[b * FLOW_LEVELS + l] = fam[l];
  }
  return out;
})();
// Every distinct glyph the flow can paint, for the cell-width check.
export const FLOW_ALPHABET = Array.from(new Set(FLOW_GLYPHS));

// Water slower than this (of the field's full scale) has no direction worth
// drawing and goes to the eddy bucket.
const EDDY_SPEED = 0.16;

function bucketOf(dx, dy, speed) {
  if (speed < EDDY_SPEED) return 8;
  // Screen y grows downward; -dy turns it back into "north is up".
  let k = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4));
  k %= 8;
  if (k < 0) k += 8;
  return k;
}

/* Where on Earth a cell of the extended grid is, folded over the poles and
   wrapped round the antimeridian. `out` is written in place.
     lat/lon   the physical point
     fold      -1 when the chart folded over a pole (north and south swap)
     fade      how much of the flow survives out here, 0..1
     wrapped   the world column the cell's meridian belongs to */
export function geoOf(col, row, cols, rows, out) {
  const lonPerCol = 360 / cols, latPerRow = 180 / rows;
  const wrapped = ((col % cols) + cols) % cols;
  let lat = 90 - row * latPerRow;
  let lon = wrapped * lonPerCol - 180;
  let fold = 1, over = 0;
  if (lat > 90) {
    over = lat - 90;
    lat = Math.max(-90, 180 - lat);
    lon = wrapLon(lon + 180);
    fold = -1;
  } else if (lat < -90) {
    over = -90 - lat;
    lat = Math.min(90, -180 - lat);
    lon = wrapLon(lon + 180);
    fold = -1;
  }
  out.lat = lat;
  out.lon = lon;
  out.fold = fold;
  out.wrapped = wrapped;
  out.fade = over ? POLE_FLOOR + (1 - POLE_FLOOR) * Math.exp(-over / POLE_FADE) : 1;
  return out;
}

/* ---- The field ---------------------------------------------------------- */

/* One wavelength of the surface swell, in pixels, and how fast a crest travels
   in the fastest water. Both are in *map* pixels, not cells, so the crests stay
   square when the grid's cells are not. */
const WAVE_PX = 78;
const CREST_PX_PER_S = 27;
// The swell water with no current of its own still carries, as a fraction of
// the fastest current's crest speed.
const CALM_SWELL = 0.16;
// Where full brightness sits in the distribution of water speeds.
const NORM_PERCENTILE = 0.88;

/* Freeze the sampler into the arrays the animation loop reads.

   cfg: { cols, rows, land, mx, my, charW, lineH }
   where mx/my are the margin in cells on each side — the open ocean — and the
   world grid sits at the fixed offset (mx, my) inside the extended grid.

   Returns the extended-grid arrays, all indexed `(row + my) * exCols + col + mx`:
     speed   Uint8   0..255, full scale at NORM_PERCENTILE of the water
     bucket  Uint8   direction bucket, 8 where the water is too slow to say
     phase   Float32 the wave's phase at this cell, in radians
     omega   Float32 radians per second, so `phase - omega * t` is a crest
                     traveling *along* the flow at the local current speed
   plus the counts the checks ask for. */
export function buildFlowField(cfg) {
  const cols = cfg.cols | 0, rows = cfg.rows | 0;
  const mx = Math.max(0, cfg.mx | 0), my = Math.max(0, cfg.my | 0);
  const exCols = cols + 2 * mx, exRows = rows + 2 * my;
  const n = exCols * exRows;
  const charW = Number(cfg.charW) || 1, lineH = Number(cfg.lineH) || 1;
  const land = cfg.land;
  const sample = velocitySampler({
    cols: cols, rows: rows, land: land, charW: charW, lineH: lineH
  });

  const vx = new Float32Array(n), vy = new Float32Array(n);
  const speed = new Uint8Array(n), bucket = new Uint8Array(n);
  const phase = new Float32Array(n), omega = new Float32Array(n);
  const mags = new Float32Array(n);
  let peak = 0, count = 0;

  for (let er = 0; er < exRows; er++) {
    const row = er - my;
    for (let ec = 0; ec < exCols; ec++) {
      const col = ec - mx;
      const i = er * exCols + ec;
      const f = sample(col, row);
      if (f.land) continue;                       // a continent does not flow
      vx[i] = f.dx; vy[i] = f.dy;
      mags[count++] = f.mag;
      if (f.mag > peak) peak = f.mag;
    }
  }

  /* Full scale is a high percentile of the water, not the single fastest cell.
     The boundary jets are two or three times anything around them, so dividing
     by the maximum would push the whole ocean into the bottom of the ramp and
     the gyres would be as dim as the doldrums. At NORM_PERCENTILE the open
     ocean uses the middle of the range and the jets simply saturate — which is
     what they look like from orbit, too. */
  const sorted = mags.subarray(0, count).slice().sort();
  const norm = count ? sorted[Math.min(count - 1, Math.floor(count * NORM_PERCENTILE))] || peak : 1;
  const inv = norm > 0 ? 1 / norm : 0;
  const k = (2 * Math.PI) / WAVE_PX;               // radians per map pixel
  let moving = 0, worldWater = 0, worldMoving = 0, onLand = 0;
  for (let er = 0; er < exRows; er++) {
    const row = er - my;
    const inRows = row >= 0 && row < rows;
    for (let ec = 0; ec < exCols; ec++) {
      const col = ec - mx;
      const i = er * exCols + ec;
      const dx = vx[i], dy = vy[i];
      const mag = Math.sqrt(dx * dx + dy * dy);
      const s = Math.min(1, mag * inv);
      const byte = Math.round(s * 255);
      speed[i] = byte;
      bucket[i] = bucketOf(dx, dy, s);
      if (byte) moving++;
      const isWorld = inRows && col >= 0 && col < cols;
      if (isWorld && land && land[row * cols + col]) {
        if (byte) onLand++;                        // the check holds this at 0
        continue;
      }
      if (isWorld) { worldWater++; if (byte) worldMoving++; }
      /* The wave's phase rises along the local flow direction, so a crest — a
         line of equal phase — lies across the current and travels down it as t
         advances, at `omega / k` pixels a second, which is the current's own
         speed. Position is in map pixels, because the cells are not square.

         Water with no current at all still has a slow swell: one eastward, at
         the floor speed. Without it a calm cell would be a cell with a frozen
         pattern in it, and the eye of a gyre would read as a bug. */
      const ux = mag > 1e-9 ? dx / mag : 1, uy = mag > 1e-9 ? dy / mag : 0;
      phase[i] = k * (ux * col * charW + uy * row * lineH);
      omega[i] = k * CREST_PX_PER_S * Math.max(s, CALM_SWELL);
    }
  }

  return {
    cols: cols, rows: rows, mx: mx, my: my, exCols: exCols, exRows: exRows,
    speed: speed, bucket: bucket, phase: phase, omega: omega,
    peak: peak, norm: norm, cells: n, moving: moving,
    worldWater: worldWater, worldMoving: worldMoving, onLand: onLand,
    gyres: GYRES.length, jets: JETS.length, bands: BANDS.length
  };
}

/* The velocity at one cell of the extended grid, in map pixels per unit time,
   with the coast damping, the antimeridian wrap and the polar fold applied.
   Shared by the field builder and the still floor; `result` is reused, so a
   caller must read it before asking again. */
export function velocitySampler(cfg) {
  const cols = cfg.cols | 0, rows = cfg.rows | 0;
  const charW = Number(cfg.charW) || 1, lineH = Number(cfg.lineH) || 1;
  const land = cfg.land;
  const damp = cfg.damp || coastDamping(land, cols, rows);
  const pxPerLon = charW / (360 / cols), pxPerLat = lineH / (180 / rows);
  const geo = { lat: 0, lon: 0, fold: 1, fade: 1, wrapped: 0 };
  const uv = { u: 0, v: 0 };
  const result = { dx: 0, dy: 0, mag: 0, land: false };
  return function sample(col, row) {
    const inRows = row >= 0 && row < rows;
    const inWorld = inRows && col >= 0 && col < cols;
    if (inWorld && land && land[row * cols + col]) {
      result.dx = 0; result.dy = 0; result.mag = 0; result.land = true;
      return result;
    }
    result.land = false;
    geoOf(col, row, cols, rows, geo);
    flowAt(geo.lat, geo.lon, uv);
    let d = 1;
    if (inRows) {
      d = damp[row * cols + geo.wrapped];
      // A margin column borrows a real meridian's land mask, softened: there is
      // no land painted out there, so a full stop would read as a stripe of dead
      // water rather than as the lee of a continent just off the map.
      if (!inWorld) d = MARGIN_DAMP_FLOOR + (1 - MARGIN_DAMP_FLOOR) * d;
    }
    const k = geo.fade * d;
    // Screen y grows downward, hence the minus; past a pole the chart folds and
    // north and south swap, hence geo.fold.
    result.dx = uv.u * pxPerLon * k;
    result.dy = -uv.v * pxPerLat * k * geo.fold;
    result.mag = Math.sqrt(result.dx * result.dx + result.dy * result.dy);
    return result;
  };
}

/* The static field, for the parts of the sea that never animate: the ring of
   far margin beyond the simulated grid, and the whole ocean under
   `prefers-reduced-motion: reduce`. Speed alone decides the level, so the gyres
   and the boundary jets are legible as streams standing still.

   Returns a sampler rather than an array: this is walked once, at build, over a
   grid that can be much larger than the simulated one, and a second copy of the
   field is the one allocation worth avoiding. */
export function createStaticFlow(cfg) {
  const sample = velocitySampler(cfg);
  const peak = Number(cfg.peak) || 1;
  const result = { speed: 0, bucket: 8, land: false };
  return function staticAt(col, row) {
    const f = sample(col, row);
    result.land = f.land;
    result.speed = f.land ? 0 : Math.min(1, f.mag / peak);
    result.bucket = f.land ? 8 : bucketOf(f.dx, f.dy, result.speed);
    return result;
  };
}

// The table as data, for the handoff note and the checks.
export function currentsSummary() {
  return {
    gyres: GYRES.map((g) => g.name),
    jets: JETS.map((j) => j.name),
    bands: BANDS.map((b) => b.name),
    wavePx: WAVE_PX, crestPxPerSecond: CREST_PX_PER_S,
    coastCells: COAST_CELLS, poleFade: POLE_FADE,
    alphabet: FLOW_ALPHABET
  };
}
