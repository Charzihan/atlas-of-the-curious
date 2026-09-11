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
  measureLineStats,
  measureNaturalWidth,
  setLocale
} from "../vendor/pretext/layout.js";
import {
  prepareRichInline,
  measureRichInlineStats,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange
} from "../vendor/pretext/rich-inline.js";

/* ------------------------------------------------------------------ *
 * 1. The pure core                                                    *
 * ------------------------------------------------------------------ */

// How many unpinned (ad-hoc string) entries to keep per role before the
// oldest ones are dropped. Text registered by id is pinned and never evicted.
const TEXT_CACHE_MAX = 512;

// The px size inside an already-resolved canvas font string. Splitting it out
// once lets a role be re-measured at an alternate size (fitted card names, the
// fitted hero headline) without leaving this pure function.
const FONT_SIZE_PX = /(\d*\.?\d+)px/;

/* --- Scripts and writing direction (pure; also used by the Node scripts) ---
   Phase 4 carries a second name for every place, in its own language and
   script. Two questions follow from that: which script is this (so the
   dataset check can count them) and which way does it run (so the span can
   carry the right `dir`).

   The direction answer prefers pretext's own per-segment bidi levels — the
   richer prepared handle carries approximate `segLevels`, and an odd level is
   a right-to-left run — and falls back to the BCP 47 tag when the text has no
   strong RTL character at all (`segLevels` is then null by design). */

// A tag whose primary subtag (or explicit script subtag) is written RTL.
const RTL_LANGS = new Set([
  "ar", "he", "fa", "ur", "ps", "sd", "yi", "dv", "ckb", "ug", "arc", "nqo", "syr"
]);
const RTL_SCRIPTS = new Set(["arab", "hebr", "thaa", "syrc", "nkoo", "adlm", "aran"]);

// "ar", "ar-EG", "az-Arab" -> "rtl"; everything else -> "ltr".
export function dirForLang(tag) {
  const parts = String(tag || "").toLowerCase().split("-");
  if (RTL_LANGS.has(parts[0])) return "rtl";
  for (let i = 1; i < parts.length; i++) if (RTL_SCRIPTS.has(parts[i])) return "rtl";
  return "ltr";
}

// Tested in order: kana beats Han (Japanese mixes both), Hangul beats Han.
export const SCRIPT_TESTS = [
  ["Arabic", /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/],
  ["Hebrew", /[\u0590-\u05FF]/],
  ["Japanese", /[\u3040-\u309F\u30A0-\u30FF]/],
  ["Hangul", /[\u1100-\u11FF\uAC00-\uD7AF]/],
  ["Han", /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/],
  ["Thai", /[\u0E00-\u0E7F]/],
  ["Khmer", /[\u1780-\u17FF]/],
  ["Tibetan", /[\u0F00-\u0FFF]/],
  ["Sinhala", /[\u0D80-\u0DFF]/],
  ["Devanagari", /[\u0900-\u097F]/],
  ["Cyrillic", /[\u0400-\u04FF]/],
  ["Greek", /[\u0370-\u03FF]/],
  ["Latin", /[A-Za-z\u00C0-\u024F]/]
];

export function scriptOfText(text) {
  const str = String(text == null ? "" : text);
  for (const test of SCRIPT_TESTS) if (test[1].test(str)) return test[0];
  return "Unknown";
}

// Direction of the first strong segment of a prepared (with segments) handle.
// `fallback` is used when the text carries no strong RTL character, which is
// exactly when pretext leaves `segLevels` null.
export function directionFromLevels(pre, fallback) {
  const levels = pre && pre.segLevels;
  const dir = fallback === "rtl" ? "rtl" : "ltr";
  if (!levels || !levels.length) return dir;
  const kinds = (pre && pre.kinds) || null;
  for (let i = 0; i < levels.length; i++) {
    if (kinds && kinds[i] !== "text") continue;   // spaces and tabs are neutral
    return (levels[i] & 1) ? "rtl" : "ltr";
  }
  return (levels[0] & 1) ? "rtl" : "ltr";
}

export function createMetrics(fontRoles) {
  const roles = new Map();
  const src = fontRoles || {};
  for (const name of Object.keys(src)) {
    const r = src[name] || {};
    const font = String(r.font || "");
    const at = FONT_SIZE_PX.exec(font);
    roles.set(name, {
      name: name,
      font: font,
      // The role's own size, plus the two halves of its font string around it.
      fontPx: at ? parseFloat(at[1]) : 0,
      fontHead: at ? font.slice(0, at.index) : "",
      fontTail: at ? font.slice(at.index + at[0].length) : "",
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

  /* --- Localized preparation (Phase 4) --------------------------------
     A native name has to be segmented in its own language: pretext reads the
     locale through Intl.Segmenter, and `setLocale()` is a *global* switch that
     also clears the shared measurement caches (already-prepared handles stay
     valid). Calling it per render would throw the caches away dozens of times
     a frame, so every localized string is queued here and prepared in one
     grouped pass: setLocale(locale) once per group, prepare that group, and a
     single setLocale() back to the default at the end. */
  const localizedQueue = [];
  // role -> Map(text -> { locale, wordBreak }) — what a handle was built with.
  const localeOf = new Map();

  function noteLocale(role, text, locale, wordBreak) {
    let m = localeOf.get(role.name);
    if (!m) { m = new Map(); localeOf.set(role.name, m); }
    m.set(text, { locale: locale, wordBreak: wordBreak });
  }

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

  /* --- The same role at another font size ------------------------------
     Fitted text (a long card name stepped down a notch, a headline sized to
     land on exactly two lines) is still the role's font stack, weight and
     style — only the size moves. These keep a separate cache so the role's own
     prepared handles are never disturbed, and stay pure: no DOM, no window.

     `--lh-<role>` is a unitless multiplier in the registry, so the line height
     scales with the size. `--ls-<role>` was already resolved to px at boot and
     is carried over unchanged (every role that is measured at an alternate
     size declares `0px`, so there is nothing to scale). */
  const preparedAt = new Map(); // roleName -> Map(sizeKey -> Map(text -> entry))
  const evictableAt = [];       // [roleName, sizeKey, text], oldest first

  function round2px(n) { return Math.round(n * 100) / 100; }

  function fontAtPx(role, fontPx) {
    if (!role.fontPx) return role.font;
    return role.fontHead + round2px(fontPx) + "px" + role.fontTail;
  }
  function lineHeightAtPx(role, fontPx) {
    if (!role.fontPx) return role.lineHeight;
    return (role.lineHeight * fontPx) / role.fontPx;
  }

  function entryAt(role, fontPx, text, needLines) {
    // The role's own size already has a (possibly pinned) handle — reuse it.
    if (!role.fontPx || Math.abs(fontPx - role.fontPx) < 0.01) {
      return adHoc(role, text, needLines);
    }
    const key = String(round2px(fontPx));
    let bySize = preparedAt.get(role.name);
    if (!bySize) { bySize = new Map(); preparedAt.set(role.name, bySize); }
    let bucket = bySize.get(key);
    if (!bucket) { bucket = new Map(); bySize.set(key, bucket); }
    let entry = bucket.get(text);
    if (!entry) {
      const font = fontAtPx(role, fontPx);
      entry = {
        segments: !!needLines,
        pre: needLines
          ? prepareWithSegments(text, font, optionsFor(role))
          : prepare(text, font, optionsFor(role))
      };
      bucket.set(text, entry);
      evictableAt.push([role.name, key, text]);
      while (evictableAt.length > TEXT_CACHE_MAX) {
        const gone = evictableAt.shift();
        const bySizeOld = preparedAt.get(gone[0]);
        const old = bySizeOld && bySizeOld.get(gone[1]);
        if (old) old.delete(gone[2]);
      }
    } else if (needLines && !entry.segments) {
      entry.pre = prepareWithSegments(text, fontAtPx(role, fontPx), optionsFor(role));
      entry.segments = true;
    }
    return entry;
  }

  /* --- The same roles, in pre-wrap mode --------------------------------
     A visitor's note is textarea text: ordinary spaces, `\t` tabs and `\n`
     hard breaks all have to survive, which is exactly pretext's
     `{ whiteSpace: "pre-wrap" }`. The same (role, text) pair means something
     different in the two modes, so pre-wrap handles live in their own bucket
     — keyed by the role name with a suffix no role can spell — and never
     disturb the normal-flow handle for the same string.

     Still pure: no DOM, no window, same eviction discipline. */
  const PRE_SUFFIX = "\u0000pre";
  const evictablePre = [];       // [bucketName, text], oldest first

  function entryPre(role, text, needLines) {
    const bucketName = role.name + PRE_SUFFIX;
    let bucket = prepared.get(bucketName);
    if (!bucket) { bucket = new Map(); prepared.set(bucketName, bucket); }
    let entry = bucket.get(text);
    if (!entry) {
      const options = { whiteSpace: "pre-wrap" };
      if (role.letterSpacing) options.letterSpacing = role.letterSpacing;
      entry = {
        text: text, segments: !!needLines, pinned: false,
        pre: needLines
          ? prepareWithSegments(text, role.font, options)
          : prepare(text, role.font, options)
      };
      bucket.set(text, entry);
      evictablePre.push([bucketName, text]);
      while (evictablePre.length > TEXT_CACHE_MAX) {
        const gone = evictablePre.shift();
        const old = prepared.get(gone[0]);
        if (old) old.delete(gone[1]);
      }
    } else if (needLines && !entry.segments) {
      const options = { whiteSpace: "pre-wrap" };
      if (role.letterSpacing) options.letterSpacing = role.letterSpacing;
      entry.pre = prepareWithSegments(text, role.font, options);
      entry.segments = true;
    }
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

    // --- registration in another language ------------------------------
    // Queue one string to be prepared under `options.locale` (and optionally
    // `options.wordBreak: "keep-all"`, which is what CJK/Hangul want). Nothing
    // is prepared until flushLocalized() runs — see the comment above.
    prepareLocalized: function (role, id, text, options) {
      const r = roleOf(role);
      const str = text == null ? "" : String(text);
      const locale = (options && options.locale) || "";
      const wordBreak = (options && options.wordBreak) || "normal";
      localizedQueue.push({
        role: r, id: id, text: str, locale: locale, wordBreak: wordBreak
      });
      // Answer has()/textForId() straight away: the handle arrives at flush.
      let m = ids.get(r.name);
      if (!m) { m = new Map(); ids.set(r.name, m); }
      m.set(id, str);
      return api;
    },

    // Prepare everything prepareLocalized() queued, grouped by locale so
    // pretext's global caches are cleared once per group instead of once per
    // string, and leave the library back on the default locale.
    flushLocalized: function () {
      const out = { groups: 0, prepared: 0, reused: 0, locales: [] };
      if (!localizedQueue.length) return out;
      const groups = new Map();
      for (const q of localizedQueue) {
        const key = q.locale + " " + q.wordBreak;
        let g = groups.get(key);
        if (!g) { g = []; groups.set(key, g); }
        g.push(q);
      }
      localizedQueue.length = 0;
      for (const group of groups.values()) {
        const locale = group[0].locale;
        const wordBreak = group[0].wordBreak;
        out.groups++;
        if (out.locales.indexOf(locale || "(default)") === -1) {
          out.locales.push(locale || "(default)");
        }
        setLocale(locale || undefined);
        for (const q of group) {
          let bucket = prepared.get(q.role.name);
          if (!bucket) { bucket = new Map(); prepared.set(q.role.name, bucket); }
          const already = bucket.get(q.text);
          if (already && already.pinned && already.segments) { out.reused++; continue; }
          const options = {};
          if (q.role.letterSpacing) options.letterSpacing = q.role.letterSpacing;
          if (wordBreak !== "normal") options.wordBreak = wordBreak;
          bucket.set(q.text, {
            text: q.text, segments: true, pinned: true,
            pre: prepareWithSegments(q.text, q.role.font, options)
          });
          noteLocale(q.role, q.text, locale, wordBreak);
          out.prepared++;
        }
      }
      setLocale(); // back to the page's own locale, exactly once
      return out;
    },

    // What a registered string was prepared with, or null.
    localeFor: function (role, id) {
      const r = roleOf(role);
      const m = localeOf.get(r.name);
      const text = (ids.get(r.name) || new Map()).get(id);
      const rec = m && typeof text === "string" ? m.get(text) : null;
      return rec ? { locale: rec.locale, wordBreak: rec.wordBreak } : null;
    },

    // --- writing direction ---------------------------------------------
    // "rtl" / "ltr" from pretext's own per-segment bidi levels, with the
    // language tag as the fallback for text that carries no strong RTL run.
    directionOf: function (role, id, langTag) {
      const r = roleOf(role);
      const e = entryFor(r, textForId(r, id), true);
      return directionFromLevels(e.pre, dirForLang(langTag));
    },
    directionOfText: function (role, text, langTag) {
      const r = roleOf(role);
      const e = adHoc(r, text == null ? "" : String(text), true);
      return directionFromLevels(e.pre, dirForLang(langTag));
    },

    // --- rich inline flow (chips, and Phase 4's highlighted taglines) ----
    // Thin, pure wrappers over pretext's rich-inline helper so a classic
    // script (js/app.js cannot import a module) can reach it through
    // window.ATLAS_TEXT.
    prepareRich: function (items) { return prepareRichInline(items || []); },
    richStats: function (rich, width) { return measureRichInlineStats(rich, width); },
    // One entry per laid-out line: the fragments with their x offsets, in
    // source-item order, ready to be painted as one block per line.
    richLines: function (rich, width) {
      const out = [];
      walkRichInlineLineRanges(rich, width, function (range) {
        const line = materializeRichInlineLineRange(rich, range);
        let x = 0;
        const fragments = [];
        for (const f of line.fragments) {
          x += f.gapBefore;
          fragments.push({
            itemIndex: f.itemIndex, text: f.text, x: x,
            width: f.occupiedWidth,
            // The compiler trims whitespace off an item's edges and carries it
            // here as a width instead of a character. A caller that paints the
            // fragments in normal inline flow (rather than at `x`) has to put
            // that space back, or the words run together.
            gapBefore: f.gapBefore
          });
          x += f.occupiedWidth;
        }
        out.push({ fragments: fragments, width: x });
      });
      return out;
    },

    // --- the raw prepared handle --------------------------------------
    // Manual line layout (the dialog's justified columns) needs the
    // per-segment widths, break kinds and hyphen width that only
    // prepareWithSegments() carries. These hand the very same cached handle
    // every other answer above is computed from — a height-only entry is
    // upgraded in place — so nothing is ever prepared twice.
    handleFor: function (role, id) {
      const r = roleOf(role);
      return entryFor(r, textForId(r, id), true).pre;
    },
    handleForText: function (role, text) {
      const r = roleOf(role);
      return adHoc(r, text == null ? "" : String(text), true).pre;
    },
    handleForTextAt: function (role, text, fontPx) {
      const r = roleOf(role);
      const px = fontPx == null ? r.fontPx : fontPx;
      return entryAt(r, px, text == null ? "" : String(text), true).pre;
    },

    // The pure script / direction helpers, published on the instance so a
    // classic script (and scripts/smoke.mjs, which cannot import a module into
    // the page) can reach the same answers this module gives.
    scriptOf: scriptOfText,
    dirForLang: dirForLang,
    keepAllFor: keepAllFor,

    // --- the role's own metrics ---------------------------------------
    fontFor: function (role) {
      const r = roleOf(role);
      return {
        font: r.font, fontPx: r.fontPx,
        lineHeight: r.lineHeight, letterSpacing: r.letterSpacing
      };
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
    },

    // --- the same roles, in pre-wrap mode (a visitor's own text) ---------
    // Ordinary spaces, tabs and hard breaks are all preserved, which is what
    // a <textarea> does. heightOfPreWrap() is the one the notebook's height
    // comes from on every keystroke: pure arithmetic, never `scrollHeight`.
    heightOfPreWrap: function (role, text, width) {
      const r = roleOf(role);
      const e = entryPre(r, text == null ? "" : String(text), false);
      return layout(e.pre, width, r.lineHeight).height;
    },
    lineCountOfPreWrap: function (role, text, width) {
      const r = roleOf(role);
      const e = entryPre(r, text == null ? "" : String(text), false);
      return layout(e.pre, width, r.lineHeight).lineCount;
    },
    linesOfPreWrap: function (role, text, width) {
      const r = roleOf(role);
      const e = entryPre(r, text == null ? "" : String(text), true);
      return layoutWithLines(e.pre, width, r.lineHeight).lines.map(lineText);
    },
    handleForPreWrap: function (role, text) {
      const r = roleOf(role);
      return entryPre(r, text == null ? "" : String(text), true).pre;
    },

    // --- the same roles, measured at an alternate font size --------------
    // `fontPx` is a CSS px size. The role's stack, weight/style and letter
    // spacing are unchanged; the line height scales with the size.
    fontAt: function (role, fontPx) {
      const r = roleOf(role);
      const px = fontPx == null ? r.fontPx : fontPx;
      return {
        font: fontAtPx(r, px), fontPx: px,
        lineHeight: lineHeightAtPx(r, px), letterSpacing: r.letterSpacing
      };
    },
    heightOfAt: function (role, id, width, fontPx) {
      const r = roleOf(role);
      const e = entryAt(r, fontPx, textForId(r, id), false);
      return layout(e.pre, width, lineHeightAtPx(r, fontPx)).height;
    },
    lineCountOfAt: function (role, id, width, fontPx) {
      const r = roleOf(role);
      const e = entryAt(r, fontPx, textForId(r, id), false);
      return layout(e.pre, width, lineHeightAtPx(r, fontPx)).lineCount;
    },
    heightOfTextAt: function (role, text, width, fontPx) {
      const r = roleOf(role);
      const e = entryAt(r, fontPx, text == null ? "" : String(text), false);
      return layout(e.pre, width, lineHeightAtPx(r, fontPx)).height;
    },
    lineCountOfTextAt: function (role, text, width, fontPx) {
      const r = roleOf(role);
      const e = entryAt(r, fontPx, text == null ? "" : String(text), false);
      return layout(e.pre, width, lineHeightAtPx(r, fontPx)).lineCount;
    },
    // Widest forced line: the narrowest box that still keeps the text on one
    // line. `fontPx` defaults to the role's own size.
    naturalWidthOfText: function (role, text, fontPx) {
      const r = roleOf(role);
      const px = fontPx == null ? r.fontPx : fontPx;
      const e = entryAt(r, px, text == null ? "" : String(text), true);
      return measureNaturalWidth(e.pre);
    },
    // tightWidthOfText with an explicit target line count and font size, so a
    // headline can be shrink-wrapped to exactly N balanced lines.
    tightWidthOfTextAt: function (role, text, maxWidth, fontPx, targetLines) {
      const r = roleOf(role);
      const px = fontPx == null ? r.fontPx : fontPx;
      const e = entryAt(r, px, text == null ? "" : String(text), true);
      const target = targetLines == null
        ? measureLineStats(e.pre, maxWidth).lineCount
        : targetLines;
      return shrink(e.pre, maxWidth, target);
    }
  };

  return api;
}

function lineText(l) { return l.text; }

/* ------------------------------------------------------------------ *
 * 2. Font-role registry: CSS custom properties -> canvas font strings  *
 * ------------------------------------------------------------------ */

// Phase 7 canvas stories: the resolved family is sent to both layout hosts.
// Keep the existing candidate sizes and rounded 1.26 line heights together.
export const MAP_STORY_TYPE = Object.freeze({
  familyProperty: "--font-serif",
  familyFallback: "Georgia, serif",
  candidates: Object.freeze([14, 13, 12, 11, 10].map(size => Object.freeze({ size, lineHeight: Math.round(size * 1.26) }))),
  inset: Object.freeze({ size: 12, lineHeight: 16 })
});

export function readMapStoryFamily(doc) {
  return doc.defaultView.getComputedStyle(doc.documentElement)
    .getPropertyValue(MAP_STORY_TYPE.familyProperty).trim() || MAP_STORY_TYPE.familyFallback;
}

// Every role the site knows about. Roles nothing renders yet still resolve, so
// later phases can rely on them being present.
export const ROLE_NAMES = [
  "card-name",
  "card-tagline",
  "card-loc",
  "card-link",
  "hero-title",
  "story",
  "quote",
  "dropcap",
  "field",
  "field-chip",
  "chip",
  "map-label",
  "ocean-label",
  "hover-card",
  "notebook",
  // Phase 4 — the name in its own script, and the bold half of a highlighted
  // search match.
  "native-name",        // .map-card-native and .dialog-native
  "card-native",        // .card-native, the small line under a card's name
  "map-label-native",   // .map-label-native, the label's middle line
  "card-tagline-strong", // the bold run inside a highlighted card tagline
  // Phase 6 — the paginated field guide (js/reader.js).
  "book-body",          // .book-line, the reader's body copy
  "book-title",         // .book-title, a place's name on its first page
  "book-meta",          // .book-meta, "COUNTRY \u00B7 REGION"
  "book-tagline"        // .book-tagline, the line that closes the head block
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
  metrics: true,
  // Phase 2 — the predictive grid.
  predictiveGrid: true, // card heights are arithmetic; layoutMasonry only writes
  flip: true,           // cards glide from their old slot to the new one
  scrollAnchor: true,   // the card under the pointer / focus keeps its place
  fitText: true,        // balanced taglines, fitted names, fitted headline
  expandInPlace: true,  // click a card to open its story inside the grid
  // Phase 3 — the editorial field note (js/dialog.js).
  editorial: true,      // the dialog story is set as a spread, not a paragraph
  justify: true,        // the wide-screen columns are justified (Knuth-Plass)
  reveal: true,         // the laid-out lines fade in one at a time
  hyphens: true,        // soft hyphens are injected into long place names
  chips: true,          // best-time / nearest-city set as rich inline chips
  dialogAnimate: true,  // prev/next animates the dialog body's height
  // Phase 4 — names in their own script.
  nativeNames: true,    // the native name under the Latin one (card, hover
                        // card, dialog) and as the map label's middle line
  searchHighlight: true,// matched tokens in a card tagline are set bold
  localeText: true,     // native strings are prepared under their own locale
  // Phase 5 — the map in a worker (js/map.js).
  worker: true, seaStories: true, idleSea: true, seaClick: true,
  // Phases 7–8 — shapes, routes, and proportional map ink.
  countryStories: true, routeText: true, serifAtlas: true,
  asciiClouds: true,    // the sky is drawn in the map's own alphabet (js/clouds.js);
                        // off restores the blurred radial-gradient blobs
  // Phase 6 — ways to read.
  bookMode: true,       // "Read as a book": the paginated field guide
  notebook: true        // the visitor's notebook in the dialog and the reader
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
        // Long names are fitted by stepping the font size down (--name-size),
        // so measure at the size the browser actually used.
        height = metrics.heightOfAt(
          "card-name", id, child.clientWidth, parseFloat(childStyle.fontSize)
        );
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

// The three roles a native name is painted in. All three are prepared in the
// same locale group, so the map label, the card and the hover card / dialog
// all break the same string the same way.
const NATIVE_ROLES = ["native-name", "card-native", "map-label-native"];

// CSS `word-break: keep-all` (and pretext's matching option) is for the
// scripts that write without spaces between words and whose glue rules
// pretext models: Chinese, Japanese and Korean.
const KEEP_ALL_LANGS = new Set(["zh", "ja", "ko", "yue", "wuu", "cmn"]);
export function keepAllFor(tag) {
  return KEEP_ALL_LANGS.has(String(tag || "").toLowerCase().split("-")[0]);
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

    /* The native names go FIRST, and in one grouped pass. setLocale() clears
       pretext's shared measurement caches, so anything prepared before this
       would have its cache thrown away; the handles below are built once the
       library is back on the default locale and are never disturbed again. */
    if (flags.nativeNames !== false) {
      for (const p of places) {
        if (!p.nativeName) continue;
        const options = {
          locale: flags.localeText === false ? "" : (p.nativeLang || ""),
          // CSS `word-break: keep-all` is what the native-name rules declare
          // for these tags, so the measurement has to be asked for the same.
          wordBreak: keepAllFor(p.nativeLang) ? "keep-all" : "normal"
        };
        for (const role of NATIVE_ROLES) {
          metrics.prepareLocalized(role, p.id, p.nativeName, options);
        }
      }
      win.ATLAS_LOCALE_PREP = metrics.flushLocalized();
    }

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
