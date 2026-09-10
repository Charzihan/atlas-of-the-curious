/* Atlas of the Curious — text metrics.

   Answers layout questions ("how tall will this be?", "how does it wrap?",
   "how narrow can this box get without gaining a line?") without a single DOM
   read, on top of the vendored @chenglou/pretext measurement kernel.

   The file has two halves:

   1. createMetrics(fontRoles) — pure data in, data out. It never touches
      `document` or `window`, so a later phase can move it into a Web Worker
      unchanged. `fontRoles` is a plain object:
          { roleName: { font: "<canvas font string>",
                        lineHeight: <px>, letterSpacing: <px> } }

   2. A main-thread boot section that reads the font-role registry out of
      css/style.css (the single source of truth: --font-<role>, --lh-<role>,
      --ls-<role>), resolves rem/em into px, prepares every place's name,
      tagline and story once, and publishes the instance as `window.ATLAS_TEXT`
      plus an `atlas:text-ready` event — js/app.js is a classic script and
      cannot import a module, so it picks the instance up from there.

   Measurement rules that keep pretext and the browser in agreement:
     - the canvas font string must match the CSS exactly (family, px size,
       weight/style, letter-spacing),
     - the CSS line-height must be supplied at layout time,
     - only named faces in a font stack (see the registry comment in the CSS).

   CSP-safe: same-origin module import, no eval, no inline styles, no innerHTML. */
import {
  prepare,
  prepareWithSegments,
  layout,
  layoutWithLines,
  measureLineStats
} from "../vendor/pretext/layout.js";

/* ------------------------------------------------------------------ *
 * 1. The pure core                                                    *
 * ------------------------------------------------------------------ */

// How many unpinned (ad-hoc string) entries to keep per role before the
// oldest ones are dropped. Text registered by id is pinned and never evicted.
const TEXT_CACHE_MAX = 512;

export function createMetrics(fontRoles) {
  const roles = new Map();
  const src = fontRoles || {};
  for (const name of Object.keys(src)) {
    const r = src[name] || {};
    roles.set(name, {
      name: name,
      font: String(r.font || ""),
      lineHeight: Number(r.lineHeight) || 0,
      letterSpacing: Number(r.letterSpacing) || 0
    });
  }

  // role -> Map(text -> entry). One prepared handle per (role, text), shared
  // by the id-keyed API and the arbitrary-string API so the same tagline is
  // never analysed twice.
  const prepared = new Map();
  // role -> Map(id -> text)
  const ids = new Map();
  // role -> array of unpinned texts, oldest first (cheap FIFO eviction)
  const evictable = new Map();

  function roleOf(name) {
    const r = roles.get(name);
    if (!r) throw new Error('atlas/text: unknown font role "' + name + '"');
    return r;
  }

  function optionsFor(role) {
    return role.letterSpacing ? { letterSpacing: role.letterSpacing } : undefined;
  }

  function entryFor(role, text, needLines) {
    let bucket = prepared.get(role.name);
    if (!bucket) { bucket = new Map(); prepared.set(role.name, bucket); }
    let entry = bucket.get(text);
    if (!entry) {
      entry = {
        text: text,
        segments: !!needLines,
        pinned: false,
        // prepare() is the cheaper height-only path; prepareWithSegments()
        // carries the extra bookkeeping linesOf()/tightWidth() need.
        pre: needLines
          ? prepareWithSegments(text, role.font, optionsFor(role))
          : prepare(text, role.font, optionsFor(role))
      };
      bucket.set(text, entry);
    } else if (needLines && !entry.segments) {
      // A height-only handle was asked for lines: upgrade it in place.
      entry.pre = prepareWithSegments(text, role.font, optionsFor(role));
      entry.segments = true;
    }
    return entry;
  }

  function touchEvictable(role, text) {
    let list = evictable.get(role.name);
    if (!list) { list = []; evictable.set(role.name, list); }
    list.push(text);
    if (list.length <= TEXT_CACHE_MAX) return;
    const bucket = prepared.get(role.name);
    while (list.length > TEXT_CACHE_MAX) {
      const oldest = list.shift();
      const e = bucket && bucket.get(oldest);
      if (e && !e.pinned) bucket.delete(oldest);
    }
  }

  function adHoc(role, text, needLines) {
    const bucket = prepared.get(role.name);
    const known = bucket && bucket.has(text);
    const entry = entryFor(role, text, needLines);
    if (!known && !entry.pinned) touchEvictable(role, text);
    return entry;
  }

  function textForId(role, id) {
    const m = ids.get(role.name);
    const text = m && m.get(id);
    if (typeof text !== "string") {
      throw new Error('atlas/text: nothing prepared for role "' + role.name + '", id "' + id + '"');
    }
    return text;
  }

  // Narrowest width that still produces the same line count as `maxWidth`.
  // Binary search over widths using measureLineStats() (no string building),
  // exactly the shrink-wrap trick from pretext's bubbles demo, then snap to
  // the widest actual line so the answer is a real text edge, not a probe.
  function shrink(pre, maxWidth, target) {
    let lo = 0;             // known too narrow (or unknown)
    let hi = maxWidth;      // known to produce `target` lines
    for (let i = 0; i < 30 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      if (measureLineStats(pre, mid).lineCount <= target) hi = mid;
      else lo = mid;
    }
    const stats = measureLineStats(pre, hi);
    if (stats.lineCount <= target && stats.maxLineWidth > 0) {
      return Math.min(maxWidth, stats.maxLineWidth);
    }
    return Math.min(maxWidth, hi);
  }

  const api = {
    // --- registration -------------------------------------------------
    // Register a place's text under a role so it is prepared exactly once.
    // options.lines === false prepares the cheap height-only handle; it is
    // upgraded automatically if lines are ever asked for.
    register: function (role, id, text, options) {
      const r = roleOf(role);
      const str = text == null ? "" : String(text);
      const needLines = !(options && options.lines === false);
      const entry = entryFor(r, str, needLines);
      entry.pinned = true;
      let m = ids.get(r.name);
      if (!m) { m = new Map(); ids.set(r.name, m); }
      m.set(id, str);
      return api;
    },
    has: function (role, id) {
      const m = ids.get(role);
      return !!(m && m.has(id));
    },
    roleNames: function () { return Array.from(roles.keys()); },

    // --- the role's own metrics ---------------------------------------
    fontFor: function (role) {
      const r = roleOf(role);
      return { font: r.font, lineHeight: r.lineHeight, letterSpacing: r.letterSpacing };
    },

    // --- registered text, by id ---------------------------------------
    heightOf: function (role, id, width) {
      const r = roleOf(role);
      const e = entryFor(r, textForId(r, id), false);
      return layout(e.pre, width, r.lineHeight).height;
    },
    lineCountOf: function (role, id, width) {
      const r = roleOf(role);
      const e = entryFor(r, textForId(r, id), false);
      return layout(e.pre, width, r.lineHeight).lineCount;
    },
    linesOf: function (role, id, width) {
      const r = roleOf(role);
      const e = entryFor(r, textForId(r, id), true);
      return layoutWithLines(e.pre, width, r.lineHeight).lines.map(lineText);
    },
    tightWidth: function (role, id, maxWidth) {
      const r = roleOf(role);
      const e = entryFor(r, textForId(r, id), true);
      return shrink(e.pre, maxWidth, measureLineStats(e.pre, maxWidth).lineCount);
    },

    // --- arbitrary strings (cached by role + text) ---------------------
    heightOfText: function (role, text, width) {
      const r = roleOf(role);
      const e = adHoc(r, text == null ? "" : String(text), false);
      return layout(e.pre, width, r.lineHeight).height;
    },
    lineCountOfText: function (role, text, width) {
      const r = roleOf(role);
      const e = adHoc(r, text == null ? "" : String(text), false);
      return layout(e.pre, width, r.lineHeight).lineCount;
    },
    linesOfText: function (role, text, width) {
      const r = roleOf(role);
      const e = adHoc(r, text == null ? "" : String(text), true);
      return layoutWithLines(e.pre, width, r.lineHeight).lines.map(lineText);
    },
    tightWidthOfText: function (role, text, maxWidth) {
      const r = roleOf(role);
      const e = adHoc(r, text == null ? "" : String(text), true);
      return shrink(e.pre, maxWidth, measureLineStats(e.pre, maxWidth).lineCount);
    }
  };

  return api;
}

function lineText(l) { return l.text; }

/* ------------------------------------------------------------------ *
 * 2. Font-role registry: CSS custom properties -> canvas font strings  *
 * ------------------------------------------------------------------ */

// Every role the site knows about. Roles nothing renders yet still resolve, so
// later phases can rely on them being present.
export const ROLE_NAMES = [
  "card-name",
  "card-tagline",
  "story",
  "quote",
  "chip",
  "map-label",
  "ocean-label",
  "hover-card",
  "notebook"
];

// The font-size token inside a CSS `font` shorthand: the first length that
// carries a unit (a bare number there would be a font-weight).
const SIZE_RE = /(^|[\s])(\d*\.?\d+)(px|rem|em|pt)(?=[\s/]|$)/;

function toPx(value, unit, rootPx, relativeToPx) {
  if (unit === "px") return value;
  if (unit === "rem") return value * rootPx;
  if (unit === "pt") return (value * 4) / 3;
  // `em` inside a role definition has no element to resolve against; for a
  // font-size it means the root size, for letter-spacing/line-height it means
  // the role's own size. Callers pass the right base.
  return value * relativeToPx;
}

// Turn one `--font-<role>` declaration into a canvas font string (px sizes
// only — canvas cannot resolve rem) and report the resolved size.
export function resolveFontShorthand(shorthand, rootPx) {
  const raw = String(shorthand || "").trim();
  if (!raw) return null;
  const m = SIZE_RE.exec(raw);
  if (!m) return null;
  const px = toPx(parseFloat(m[2]), m[3], rootPx, rootPx);
  const font =
    raw.slice(0, m.index) + m[1] + round2(px) + "px" + raw.slice(m.index + m[0].length);
  return { font: font.replace(/\s+/g, " ").trim(), fontPx: px };
}

// line-height: unitless multiplier, or a length. letter-spacing: `normal` or
// a length (em is relative to the role's own font size).
export function resolveLength(value, rootPx, fontPx, fallback) {
  const raw = String(value || "").trim();
  if (!raw || raw === "normal") return fallback;
  const m = /^(-?\d*\.?\d+)(px|rem|em|pt)?$/.exec(raw);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!m[2]) return n * fontPx; // unitless => multiplier of the font size
  return toPx(n, m[2], rootPx, fontPx);
}

function round2(n) { return Math.round(n * 100) / 100; }

// Read the whole registry out of the document's computed style. One pass at
// boot; nothing here runs in a hot path.
export function readFontRoles(doc, names) {
  const view = doc.defaultView;
  const rootStyle = view.getComputedStyle(doc.documentElement);
  const rootPx = parseFloat(rootStyle.fontSize) || 16;
  const out = {};
  for (const name of names || ROLE_NAMES) {
    const resolved = resolveFontShorthand(rootStyle.getPropertyValue("--font-" + name), rootPx);
    if (!resolved) continue;
    out[name] = {
      font: resolved.font,
      lineHeight: resolveLength(
        rootStyle.getPropertyValue("--lh-" + name), rootPx, resolved.fontPx, resolved.fontPx * 1.2
      ),
      letterSpacing: resolveLength(
        rootStyle.getPropertyValue("--ls-" + name), rootPx, resolved.fontPx, 0
      )
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Feature flags                                                    *
 * ------------------------------------------------------------------ */

// Defaults live here; ?flags=a,b turns features on and ?noflags=a,b turns them
// off, so a phase can be bisected in the browser without a rebuild.
export const DEFAULT_FLAGS = {
  metrics: true
};

export function resolveFlags(search, preset) {
  const flags = Object.assign({}, DEFAULT_FLAGS, preset || null);
  let params;
  try { params = new URLSearchParams(search || ""); }
  catch (e) { return flags; }
  const apply = (key, value) => {
    const list = params.get(key);
    if (!list) return;
    for (const raw of list.split(",")) {
      const name = raw.trim();
      if (name) flags[name] = value;
    }
  };
  apply("flags", true);
  apply("noflags", false); // an explicit off wins over an explicit on
  return flags;
}

/* ------------------------------------------------------------------ *
 * 4. Main-thread boot                                                 *
 * ------------------------------------------------------------------ */

function isDebugHost(loc, flagsSearch) {
  const host = (loc && loc.hostname) || "";
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return true;
  try { return new URLSearchParams(flagsSearch || "").get("debug") === "metrics"; }
  catch (e) { return false; }
}

// Development-only agreement check: does pretext predict what the browser
// actually laid out? Compares the first five cards. The text blocks come from
// heightOf(); the rest of the box (padding, symbol, location line, link) is
// read from the DOM, so any drift shows up as a text-measurement error.
function checkAgreement(metrics, doc, win) {
  const cards = Array.prototype.slice.call(doc.querySelectorAll(".card[data-place-id]"), 0, 5);
  if (!cards.length) return { checked: 0, warnings: 0 };
  const tolerance = Math.max(
    metrics.fontFor("card-name").lineHeight,
    metrics.fontFor("card-tagline").lineHeight
  );
  let warnings = 0;
  for (const card of cards) {
    const id = card.getAttribute("data-place-id");
    if (!metrics.has("card-name", id)) continue;
    const cs = win.getComputedStyle(card);
    let predicted =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const parts = [];
    for (const child of Array.prototype.slice.call(card.children)) {
      const childStyle = win.getComputedStyle(child);
      if (childStyle.position === "absolute" || childStyle.display === "none") continue;
      let height;
      if (child.tagName === "H3") {
        height = metrics.heightOf("card-name", id, child.clientWidth);
        parts.push({ part: "name", predicted: height, actual: child.offsetHeight });
      } else if (child.classList.contains("card-tag")) {
        height = metrics.heightOf("card-tagline", id, child.clientWidth);
        parts.push({ part: "tagline", predicted: height, actual: child.offsetHeight });
      } else {
        height = child.offsetHeight; // chrome, not text this phase predicts
      }
      predicted += height +
        parseFloat(childStyle.marginTop) + parseFloat(childStyle.marginBottom);
    }
    const actual = card.offsetHeight;
    if (Math.abs(predicted - actual) > tolerance) {
      warnings++;
      // eslint-disable-next-line no-console
      console.warn(
        "[atlas:text] card height disagrees with the browser for \"" + id + "\": " +
        "predicted " + round2(predicted) + "px, measured " + actual + "px " +
        "(off by " + round2(predicted - actual) + "px, tolerance " + round2(tolerance) + "px)",
        { id: id, width: card.clientWidth, parts: parts }
      );
    }
  }
  return { checked: cards.length, warnings: warnings };
}

function boot(win, doc) {
  const search = (win.location && win.location.search) || "";
  const flags = resolveFlags(search, win.ATLAS_FLAGS);
  win.ATLAS_FLAGS = flags;

  let metrics = null;
  if (flags.metrics) {
    const fontRoles = readFontRoles(doc, ROLE_NAMES);
    metrics = createMetrics(fontRoles);

    const data = win.ATLAS_DATA;
    const places = (data && data.places) || [];
    for (const p of places) {
      // Roles that display these strings today. `story` only ever needs a
      // height, so it takes the cheap prepare() path.
      metrics.register("card-name", p.id, p.name);
      metrics.register("card-tagline", p.id, p.tagline);
      metrics.register("hover-card", p.id, p.tagline);
      metrics.register("story", p.id, p.story, { lines: false });
    }
    win.ATLAS_TEXT = metrics;
  }

  win.ATLAS_TEXT_READY = true; // for listeners that attach after boot
  if (typeof win.CustomEvent === "function") {
    win.dispatchEvent(new win.CustomEvent("atlas:text-ready", {
      detail: { metrics: metrics, flags: flags }
    }));
  }

  if (metrics && isDebugHost(win.location, search)) {
    const run = () => win.requestAnimationFrame(function () {
      win.ATLAS_TEXT_AGREEMENT = checkAgreement(metrics, doc, win);
    });
    if (doc.readyState === "complete") run();
    else win.addEventListener("load", run, { once: true });
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  boot(window, document);
}
