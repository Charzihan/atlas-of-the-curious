/* Atlas of the Curious — app logic
   Security notes:
   - All data is rendered via textContent (no HTML string interpolation).
   - No inline event handlers, no eval, no external requests (CSP-enforced).
   - Place "links" use same-document URL fragments (#/place/<id>) so the
     site works on any static host without server support. */
(function () {
  "use strict";

  var DATA = window.ATLAS_DATA || { categories: [], places: [] };
  var placesById = new Map(DATA.places.map(function (p) { return [p.id, p]; }));
  var categoryById = new Map(DATA.categories.map(function (c) { return [c.id, c]; }));

  // --- Element handles -------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var searchInput = $("search-input");
  var searchForm = $("search-form");
  var chipsEl = $("category-chips");
  var sortSelect = $("sort-select");
  var grid = $("grid");
  var emptyEl = $("empty");
  var resultsStatus = $("results-status");
  var placeCount = $("place-count");
  var dialog = $("place-dialog");

  var state = { query: "", category: "all", sort: "featured", userLoc: null };

  // --- Geolocation + distance (for "Locate me" and distance sort) ----------
  function parseCoords(s) {
    var m = /(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])[\s,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])/.exec(s || "");
    if (!m) return null;
    return {
      lat: m[1] * (m[2].toUpperCase() === "S" ? -1 : 1),
      lon: m[3] * (m[4].toUpperCase() === "W" ? -1 : 1)
    };
  }
  // Haversine great-circle distance in kilometres.
  function distanceKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function fmtDist(km) { return km < 1000 ? Math.round(km) + " km" : (km / 1000).toFixed(1) + "k km"; }

  // --- Utilities -------------------------------------------------------
  function hashForPlace(id) { return "#/place/" + encodeURIComponent(id); }
  function hashForRead(id) { return "#/read/" + encodeURIComponent(id); }

  // FNV-1a hash — deterministic, cheap, no dependencies.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7))) >>> 0;
    }
    return h >>> 0;
  }

  // Stable day-based index so the "daily pick" is the same for everyone
  // on the same calendar day (UTC).
  function dailyIndex() {
    var today = new Date();
    var key = today.getUTCFullYear() + "-" + today.getUTCMonth() + "-" + today.getUTCDate();
    return fnv1a(key) % DATA.places.length;
  }

  // --- Filtering / sorting ---------------------------------------------
  function visiblePlaces() {
    var q = state.query.trim().toLowerCase();
    var out = DATA.places.filter(function (p) {
      if (state.category !== "all" && p.category !== state.category) return false;
      if (!q) return true;
      var hay = (p.name + " " + p.country + " " + p.region + " " + p.tagline + " " +
                 p.story + " " + p.fact + " " + p.bestTime + " " + p.nearestCity).toLowerCase();
      return q.split(/\s+/).every(function (tok) { return hay.indexOf(tok) !== -1; });
    });
    if (state.sort === "name") out = out.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (state.sort === "country") out = out.slice().sort(function (a, b) {
      return a.country.localeCompare(b.country) || a.name.localeCompare(b.name);
    });
    if (state.sort === "distance" && state.userLoc) out = out.slice().sort(function (a, b) {
      return distanceKm(state.userLoc, parseCoords(a.coordinates) || { lat: 0, lon: 0 }) -
             distanceKm(state.userLoc, parseCoords(b.coordinates) || { lat: 0, lon: 0 });
    });
    return out;
  }

  // --- URL state: shareable search / filter / sort ------------------------
  // Filters live in the query string (e.g. ?cat=desert&q=salt&sort=name), so
  // a page reload restores the view and "Copy link" can share a filtered list.
  function syncStateToUrl() {
    var u = new URL(location.href);
    ["q", "cat", "sort"].forEach(function (k) { u.searchParams.delete(k); });
    if (state.query) u.searchParams.set("q", state.query);
    if (state.category !== "all") u.searchParams.set("cat", state.category);
    if (state.sort !== "featured") u.searchParams.set("sort", state.sort);
    var hash = location.hash || "#/";
    try { history.replaceState(null, "", u.pathname + u.search + hash); }
    catch (e) { /* file:// — ignore */ }
  }
  function restoreStateFromUrl() {
    var u = new URL(location.href);
    state.query = u.searchParams.get("q") || "";
    state.category = u.searchParams.get("cat") || "all";
    state.sort = u.searchParams.get("sort") || "featured";
    if (!categoryById.has(state.category)) state.category = "all";
    if (state.sort !== "name" && state.sort !== "country" && state.sort !== "distance" && state.sort !== "featured") {
      state.sort = "featured";
    }
  }

  // --- Text metrics, flags, motion, viewport ----------------------------
  // js/text.js is a module that runs before this classic script, so its
  // instance is already published. Everything below degrades to the old
  // measured path when it is missing, or when a flag turns it off.
  var T = window.ATLAS_TEXT || null;
  var FLAGS = window.ATLAS_FLAGS || {};
  function flag(name) { return FLAGS[name] !== false; }

  var motionQ = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reducedMotion() { return !!(motionQ && motionQ.matches); }

  // The predicted-vs-rendered agreement check is development-only.
  var DEBUG_METRICS = (function () {
    var h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true;
    try { return new URLSearchParams(location.search).get("debug") === "metrics"; }
    catch (e) { return false; }
  })();

  var GLIDE_MS = 420;                        // filter reflow / expansion
  var ENTER_MS = 320;                        // a card rising into a new slot
  var LEAVE_MS = 260;                        // a filtered-out card fading
  var GLIDE_EASE = "cubic-bezier(0.22, 0.7, 0.3, 1)";
  var EXPAND_MIN_WIDTH = 900;                // narrower than this: use the modal
  var LINK_TEXT = "Read the field note →";   // exactly what buildCard() writes

  function r2(n) { return Math.round(n * 100) / 100; }
  function pxOf(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function locTextFor(p) { return p.country + " · " + p.region; }

  // Everything layoutMasonry() needs to know about the viewport. Refreshed at
  // boot and on resize — never inside a layout pass, which does writes only.
  var viewport = { width: 0, gridWidth: 0 };
  function readViewport() {
    viewport.width = document.documentElement.clientWidth || window.innerWidth || 0;
    viewport.gridWidth = grid.clientWidth || 0;
  }
  function canExpand() {
    return flag("expandInPlace") && viewport.width >= EXPAND_MIN_WIDTH;
  }

  // Register the strings this file renders that js/text.js does not know
  // about, so each is prepared exactly once. The uppercasing matches the CSS
  // `text-transform: uppercase` on .card-loc.
  function registerCardText() {
    if (!T) return;
    try {
      DATA.places.forEach(function (p) {
        T.register("card-loc", p.id, locTextFor(p).toUpperCase());
      });
    } catch (e) { T = null; } // a role the CSS no longer defines: fall back
  }

  // --- The name in its own script ---------------------------------------
  // A card shows it only when it is genuinely a second name — printing
  // "Pamukkale" twice would be noise, and the height arithmetic below adds
  // the line only for the cards that carry one. js/text.js already prepared
  // every native name under its own locale (role "card-native"), so nothing
  // here re-prepares anything.
  function nativeTextFor(p) {
    if (!flag("nativeNames")) return "";
    var s = String(p.nativeName || "");
    return !s || s === p.name ? "" : s;
  }
  // Without the metrics module there are no bidi levels to read, so the tag
  // decides on its own. (js/text.js owns the real list; this is the last-ditch
  // copy for the ?noflags=metrics path, where window.ATLAS_TEXT is absent.)
  var RTL_TAGS = /^(ar|he|fa|ur|ps|sd|yi|dv|ckb|ug|arc|nqo|syr)(-|$)/i;
  var nativeInfo = new Map();
  function nativeFor(p) {
    var info = nativeInfo.get(p.id);
    if (info) return info;
    var text = nativeTextFor(p);
    info = {
      text: text, lang: p.nativeLang || "", wordBreak: "normal",
      dir: RTL_TAGS.test(p.nativeLang || "") ? "rtl" : "ltr"
    };
    if (text && T) {
      try {
        info.dir = T.directionOf("card-native", p.id, p.nativeLang);
        var rec = T.localeFor("card-native", p.id);
        if (rec) info.wordBreak = rec.wordBreak;
      } catch (e) { /* the role is missing: the defaults are fine */ }
    }
    nativeInfo.set(p.id, info);
    return info;
  }

  // --- Cards (pooled so filter changes can animate, not recreate) --------
  var cardPool = new Map();
  var masonryIO = null;

  function setupReveal() {
    if (typeof IntersectionObserver !== "function") return;
    masonryIO = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("is-in");
          masonryIO.unobserve(en.target);
        }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
  }

  // One card's DOM, built once. The expansion block is created here too (and
  // kept `hidden` while collapsed), so opening a card is an attribute plus a
  // height write rather than a DOM build.
  function buildCard(p) {
    var card = document.createElement("article");
    card.className = "card";
    card.setAttribute("data-place-id", p.id);

    var sym = document.createElement("span");
    sym.className = "card-symbol";
    sym.textContent = p.symbol;
    sym.setAttribute("aria-hidden", "true");

    var h = document.createElement("h3");
    h.className = "card-name";
    h.textContent = p.name;

    var native = document.createElement("p");
    native.className = "card-native";
    var nat = nativeFor(p);
    if (nat.text) {
      native.textContent = nat.text;
      if (nat.lang) native.setAttribute("lang", nat.lang);
      native.setAttribute("dir", nat.dir);
      if (nat.wordBreak === "keep-all") native.setAttribute("data-wb", "keep-all");
    } else {
      native.hidden = true;
    }

    var loc = document.createElement("p");
    loc.className = "card-loc";
    loc.textContent = locTextFor(p);

    var tag = document.createElement("p");
    tag.className = "card-tag";
    tag.textContent = p.tagline;

    var expand = document.createElement("div");
    expand.className = "card-expand";
    expand.hidden = true;

    var story = document.createElement("p");
    story.className = "card-story";
    story.textContent = p.story;

    var note = document.createElement("div");
    note.className = "card-note";
    var noteLabel = document.createElement("span");
    noteLabel.className = "card-note-label";
    noteLabel.textContent = "Field note";
    var noteP = document.createElement("p");
    noteP.textContent = p.fact;
    note.appendChild(noteLabel);
    note.appendChild(noteP);
    expand.appendChild(story);
    expand.appendChild(note);

    var link = document.createElement("a");
    link.className = "card-more";
    link.href = hashForPlace(p.id);
    link.textContent = LINK_TEXT;

    card.appendChild(sym);
    card.appendChild(h);
    card.appendChild(native);
    card.appendChild(loc);
    card.appendChild(tag);
    card.appendChild(expand);
    card.appendChild(link);

    return {
      card: card, sym: sym, h3: h, native: native, loc: loc, tag: tag,
      expand: expand, story: story, note: note, noteLabel: noteLabel, link: link
    };
  }

  function cardFor(p, accent) {
    var existing = cardPool.get(p.id);
    if (existing) {
      existing.style.setProperty("--card-accent", accent);
      return existing;
    }
    var parts = buildCard(p);
    var card = parts.card;
    card.style.setProperty("--card-accent", accent);
    card._atlas = parts;
    cardPool.set(p.id, card);
    if (masonryIO) masonryIO.observe(card);
    else card.classList.add("is-in");
    return card;
  }

  // --- The card's chrome, read exactly once -----------------------------
  // Everything that is not text: paddings, borders, the symbol block, the
  // margins between the rows, the expansion's rule and gaps. One probe card,
  // one pass of computed style — then never a layout read again.
  var CHROME = null;

  function lineBoxOf(cs, el) {
    var lh = pxOf(cs.lineHeight);
    return lh > 0 ? lh : el.offsetHeight;
  }

  function readChrome() {
    if (!T || !DATA.places.length) return null;
    var parts = buildCard(DATA.places[0]);
    var el = parts.card;
    el.classList.add("card-probe", "is-in");
    el.style.width = "320px";
    parts.expand.hidden = false; // the expansion chrome is measured too
    parts.native.hidden = false; // …and so is the native name's margin box
    grid.appendChild(el);

    var c;
    try {
      var gridCS = getComputedStyle(grid);
      var cardCS = getComputedStyle(el);
      var symCS = getComputedStyle(parts.sym);
      var h3CS = getComputedStyle(parts.h3);
      var nativeCS = getComputedStyle(parts.native);
      var locCS = getComputedStyle(parts.loc);
      var tagCS = getComputedStyle(parts.tag);
      var linkCS = getComputedStyle(parts.link);
      var expCS = getComputedStyle(parts.expand);
      var storyCS = getComputedStyle(parts.story);
      var noteCS = getComputedStyle(parts.note);
      var labelCS = getComputedStyle(parts.noteLabel);

      c = {
        padX: pxOf(cardCS.paddingLeft) + pxOf(cardCS.paddingRight) +
              pxOf(cardCS.borderLeftWidth) + pxOf(cardCS.borderRightWidth),
        padY: pxOf(cardCS.paddingTop) + pxOf(cardCS.paddingBottom) +
              pxOf(cardCS.borderTopWidth) + pxOf(cardCS.borderBottomWidth),
        symbol: lineBoxOf(symCS, parts.sym) +
                pxOf(symCS.marginTop) + pxOf(symCS.marginBottom),
        nameMargin: pxOf(h3CS.marginTop) + pxOf(h3CS.marginBottom),
        // Only paid by the cards that actually carry a native name.
        nativeMargin: pxOf(nativeCS.marginTop) + pxOf(nativeCS.marginBottom),
        locMargin: pxOf(locCS.marginTop) + pxOf(locCS.marginBottom),
        tagMargin: pxOf(tagCS.marginTop) + pxOf(tagCS.marginBottom),
        linkMargin: pxOf(linkCS.marginTop) + pxOf(linkCS.marginBottom),
        gridPadY: pxOf(gridCS.paddingTop) + pxOf(gridCS.paddingBottom),
        expandBox: pxOf(expCS.marginTop) + pxOf(expCS.marginBottom) +
                   pxOf(expCS.paddingTop) + pxOf(expCS.paddingBottom) +
                   pxOf(expCS.borderTopWidth) + pxOf(expCS.borderBottomWidth),
        storyMargin: pxOf(storyCS.marginTop) + pxOf(storyCS.marginBottom),
        noteBox: pxOf(noteCS.marginTop) + pxOf(noteCS.marginBottom) +
                 pxOf(noteCS.paddingTop) + pxOf(noteCS.paddingBottom) +
                 pxOf(noteCS.borderTopWidth) + pxOf(noteCS.borderBottomWidth),
        notePadX: pxOf(noteCS.paddingLeft) + pxOf(noteCS.paddingRight) +
                  pxOf(noteCS.borderLeftWidth) + pxOf(noteCS.borderRightWidth),
        noteLabel: lineBoxOf(labelCS, parts.noteLabel) +
                   pxOf(labelCS.marginTop) + pxOf(labelCS.marginBottom)
      };
      // The name ladder: 1.15rem → 1.05rem → 0.95rem, expressed as fractions
      // of the role's own declared size so the CSS stays the source of truth.
      var basePx = T.fontFor("card-name").fontPx || 0;
      if (!basePx) throw new Error("card-name has no px size");
      c.nameSizes = [basePx, basePx * (1.05 / 1.15), basePx * (0.95 / 1.15)];
    } catch (e) {
      c = null;
    }
    grid.removeChild(el);
    if (!c) return null;
    c.fixed = c.padY + c.symbol + c.nameMargin + c.locMargin +
              c.tagMargin + c.linkMargin;
    c.expandFixed = c.expandBox + c.storyMargin + c.noteBox + c.noteLabel;
    return c;
  }

  // --- Masonry layout (shortest column, chenglou.me/pretext style) --------
  // Cards are absolutely positioned; column count follows viewport width
  // (1 column ≤ 520px, otherwise derived from a min-column heuristic).
  var GAP = 16;
  function colCountFor(w) {
    if (w <= 520) return 1;
    var minCol = 100 + w * 0.1;
    var n = Math.floor((w + GAP) / (minCol + GAP));
    return Math.max(2, n);
  }

  // Layout bookkeeping. `slots` is the single source of truth for where every
  // visible card is and how tall it is — the FLIP offsets and the scroll
  // anchor are computed from it, never from the DOM.
  var slots = new Map();     // id -> { left, top, height, ... }
  var attached = new Map();  // id -> el, cards currently owned by the layout
  var leaving = new Map();   // id -> timeout, cards fading out before removal
  var expandedId = null;
  var hoverId = null;        // the last card the pointer was over
  var writeCounts = new Map();
  var lastLayout = null;
  var layoutRuns = 0;

  // The largest size on the ladder whose one-line width still fits the column.
  function fitNameSize(p, textW) {
    var sizes = CHROME.nameSizes;
    for (var i = 0; i < sizes.length; i++) {
      if (T.naturalWidthOfText("card-name", p.name, sizes[i]) <= textW) return sizes[i];
    }
    return sizes[sizes.length - 1]; // the floor: it takes two lines there
  }

  /* --- Search matches, picked out in bold -------------------------------
     While a query is running the tagline stops being one string the browser
     wraps and becomes a rich-inline flow over two fonts — the `card-tagline`
     role and its bold variant `card-tagline-strong`. pretext measures the
     mixed run, the card's predicted height is that flow's line count
     (measureRichInlineStats), and each line is painted as its own block, so
     the browser has no wrapping decision of its own left to make. Clearing
     the search puts the plain, balanced tagline back. */
  function queryTokens() {
    var q = state.query.trim().toLowerCase();
    if (!q) return [];
    return q.split(/\s+/).filter(function (t) { return t.length >= 2; });
  }
  function highlighting() {
    return !!(T && flag("searchHighlight") &&
              typeof T.prepareRich === "function" && queryTokens().length);
  }

  // Alternating plain / matched runs of `text`, or null when nothing matched.
  // Overlapping tokens are merged into one run rather than nested.
  function markRuns(text, tokens) {
    var hay = text.toLowerCase();
    var hit = new Uint8Array(text.length);
    var any = false;
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      var from = 0;
      for (;;) {
        var at = hay.indexOf(tok, from);
        if (at === -1) break;
        for (var i = at; i < at + tok.length; i++) hit[i] = 1;
        any = true;
        from = at + tok.length;
      }
    }
    if (!any) return null;
    var runs = [];
    var start = 0;
    for (var j = 1; j <= text.length; j++) {
      if (j === text.length || hit[j] !== hit[j - 1]) {
        runs.push({ text: text.slice(start, j), match: !!hit[start] });
        start = j;
      }
    }
    return runs;
  }

  // One prepared flow per (place, width, query). Nothing here touches the DOM.
  var flowCache = new Map();
  function taglineFlow(p, textW) {
    if (!highlighting()) return null;
    var tokens = queryTokens();
    var key = p.id + "|" + r2(textW) + "|" + tokens.join(" ");
    if (flowCache.has(key)) return flowCache.get(key);
    var runs = markRuns(p.tagline, tokens);
    var flow = null;
    if (runs) {
      try {
        var plain = T.fontFor("card-tagline");
        var strong = T.fontFor("card-tagline-strong");
        var items = runs.map(function (run) {
          return {
            text: run.text,
            font: run.match ? strong.font : plain.font,
            letterSpacing: run.match ? strong.letterSpacing : plain.letterSpacing
          };
        });
        var rich = T.prepareRich(items);
        var stats = T.richStats(rich, textW);
        flow = {
          rich: rich, runs: runs, width: textW,
          lineCount: Math.max(1, stats.lineCount),
          maxLineWidth: stats.maxLineWidth,
          lineHeight: plain.lineHeight,
          matches: runs.filter(function (run) { return run.match; }).length
        };
      } catch (e) { flow = null; }
    }
    if (flowCache.size > 600) flowCache.clear();
    flowCache.set(key, flow);
    return flow;
  }

  // Paint (or un-paint) one card's tagline. The generated lines are
  // aria-hidden and a plain, visually hidden copy carries the sentence, so a
  // screen reader and find-in-page still see one ordinary tagline.
  function renderTagline(el, p, flow) {
    if (!flow) {
      if (el.getAttribute("data-flowed") !== null || el.firstElementChild) {
        el.textContent = p.tagline;
        el.removeAttribute("data-flowed");
      } else if (el.textContent !== p.tagline) {
        el.textContent = p.tagline;
      }
      return;
    }
    var lines = T.richLines(flow.rich, flow.width);
    el.textContent = "";
    var plainEl = document.createElement("span");
    plainEl.className = "visually-hidden";
    plainEl.textContent = p.tagline;
    el.appendChild(plainEl);
    for (var i = 0; i < lines.length; i++) {
      var lineEl = document.createElement("span");
      lineEl.className = "tag-line";
      lineEl.setAttribute("aria-hidden", "true");
      var frags = lines[i].fragments;
      for (var f = 0; f < frags.length; f++) {
        var frag = frags[f];
        var txt = frag.text;
        if (f === 0) txt = txt.replace(/^\s+/, "");
        if (f === frags.length - 1) txt = txt.replace(/\s+$/, "");
        if (!txt) continue;
        // The rich-inline compiler trims the space between two items and
        // carries it as `gapBefore` (a width, not a character). Every gap here
        // came from a plain run — a search token can never begin or end with
        // whitespace — so painting one plain space back is exactly the width
        // pretext counted.
        if (frag.gapBefore > 0 && lineEl.firstChild) {
          var gap = document.createElement("span");
          gap.textContent = " ";
          lineEl.appendChild(gap);
        }
        var run = flow.runs[frag.itemIndex];
        var isMatch = !!(run && run.match);
        var span = document.createElement(isMatch ? "strong" : "span");
        if (isMatch) span.className = "hl";
        span.textContent = txt;
        lineEl.appendChild(span);
      }
      el.appendChild(lineEl);
    }
    el.setAttribute("data-flowed", String(lines.length));
  }

  // Shrink-wrap a text block to the narrowest box that keeps the line count it
  // was measured at. Two things fall out of that: the last line carries its
  // share of the words (balanced text), and the browser's own line breaking is
  // no longer being asked a borderline question — a container within a
  // fraction of a pixel of the text's natural width is exactly where pretext
  // and Chrome's sub-pixel glyph rounding can disagree by a whole line. One
  // px of slack, capped at the column, removes that class of drift.
  function wrapWidth(tight, textW) {
    return Math.min(textW, Math.ceil(tight) + 1);
  }

  // A card's height, as arithmetic. Nothing here touches the DOM.
  function predictCard(p, textW, expanded) {
    var fit = flag("fitText");
    var nameSize = fit ? fitNameSize(p, textW) : CHROME.nameSizes[0];
    var native = nativeFor(p);
    // A highlighted tagline is measured as a rich-inline flow instead; the
    // line count that comes back is what the card is made tall enough for.
    var flow = taglineFlow(p, textW);
    var h = CHROME.fixed +
      T.heightOfAt("card-name", p.id, textW, nameSize) +
      (native.text
        ? CHROME.nativeMargin + T.heightOfText("card-native", native.text, textW)
        : 0) +
      T.heightOf("card-loc", p.id, textW) +
      (flow ? flow.lineCount * flow.lineHeight : T.heightOf("card-tagline", p.id, textW)) +
      T.heightOfText("card-link", LINK_TEXT, textW);
    var nameWidth = 0, locWidth = 0, tagWidth = 0;
    if (fit) {
      nameWidth = wrapWidth(
        T.tightWidthOfTextAt("card-name", p.name, textW, nameSize), textW);
      locWidth = wrapWidth(T.tightWidth("card-loc", p.id, textW), textW);
      // A flowed tagline is already laid out line by line; shrink-wrapping the
      // box under it would only invite the browser to disagree.
      if (!flow) tagWidth = wrapWidth(T.tightWidth("card-tagline", p.id, textW), textW);
    }
    var extra = expanded
      ? CHROME.expandFixed +
        T.heightOf("story", p.id, textW) +
        T.heightOfText("story", p.fact, textW - CHROME.notePadX)
      : 0;
    return {
      height: h + extra, nameSize: nameSize,
      nameWidth: nameWidth, locWidth: locWidth, tagWidth: tagWidth,
      tagFlow: flow, native: native.text ? native : null
    };
  }

  // Which card should keep its on-screen position through a reflow: the one
  // holding keyboard focus, else the last one the pointer was over.
  function anchorId() {
    if (!flag("scrollAnchor")) return null;
    var active = document.activeElement;
    if (active && active !== document.body && grid.contains(active) && active.closest) {
      var focused = active.closest(".card[data-place-id]");
      if (focused) return focused.getAttribute("data-place-id");
    }
    return hoverId;
  }

  function countWrite(id) {
    writeCounts.set(id, (writeCounts.get(id) || 0) + 1);
  }

  function setWrapWidth(el, width) {
    if (width) el.style.setProperty("max-width", r2(width) + "px");
    else el.style.removeProperty("max-width");
  }

  function scrollByInstant(dy) {
    // html { scroll-behavior: smooth } would animate this; the whole point is
    // that the anchored card never appears to move at all.
    try { window.scrollBy({ top: dy, left: 0, behavior: "instant" }); }
    catch (e) { window.scrollBy(0, dy); }
  }

  function stopLeaving(id, el) {
    var t = leaving.get(id);
    if (t == null) return;
    clearTimeout(t);
    leaving.delete(id);
    el.classList.remove("is-leaving");
  }

  function detachCard(id, el, animate) {
    attached.delete(id);
    if (!animate) {
      if (el.parentNode === grid) grid.removeChild(el);
      return;
    }
    el.classList.add("is-leaving"); // CSS transitions the opacity down
    leaving.set(id, setTimeout(function () {
      leaving.delete(id);
      el.classList.remove("is-leaving");
      if (el.parentNode === grid) grid.removeChild(el);
    }, LEAVE_MS + 60));
  }

  // WRITES ONLY. Every number comes from pretext plus the boot-time chrome
  // probe; there is no offsetHeight / getBoundingClientRect / clientWidth in
  // this function or in anything it calls.
  function layoutMasonry(placesArg, opts) {
    var places = placesArg || visiblePlaces();
    if (!(T && CHROME && flag("predictiveGrid"))) {
      layoutMeasured(places);
      return;
    }
    var w = viewport.gridWidth;
    if (!w) return;

    if (expandedId && !canExpand()) expandedId = null;
    if (expandedId) {
      var stillThere = false;
      for (var k = 0; k < places.length; k++) {
        if (places[k].id === expandedId) { stillThere = true; break; }
      }
      if (!stillThere) expandedId = null;
    }

    var n = colCountFor(w);
    var colW = (w - GAP * (n - 1)) / n;
    var textW = colW - CHROME.padX;
    var colH = [];
    for (var i = 0; i < n; i++) colH.push(0);

    // 1. Decide everything, arithmetically.
    var next = new Map();
    places.forEach(function (p) {
      var pred = predictCard(p, textW, p.id === expandedId);
      var col = 0;
      for (var j = 1; j < n; j++) if (colH[j] < colH[col]) col = j;
      next.set(p.id, {
        left: r2(col * (colW + GAP)),
        top: r2(colH[col]),
        height: pred.height,
        nameSize: pred.nameSize,
        nameWidth: pred.nameWidth,
        locWidth: pred.locWidth,
        tagWidth: pred.tagWidth,
        tagFlow: pred.tagFlow,
        native: pred.native,
        textW: textW,
        expanded: p.id === expandedId
      });
      colH[col] += pred.height + GAP;
    });

    // 2. How far the anchored card is about to move, so the page can be
    //    scrolled by exactly that much in this same frame, before paint.
    var first = !slots.size;
    var scrollDelta = 0;
    // A resize moves the whole page under the reader anyway (the hero and the
    // map resize too), so grid-relative compensation would fight it.
    if (!first && !(opts && opts.noAnchor)) {
      var aid = anchorId();
      var was = aid && slots.get(aid);
      var will = aid && next.get(aid);
      if (was && will) scrollDelta = will.top - was.top;
    }

    var animate = flag("flip") && !first && !reducedMotion() &&
                  typeof Element.prototype.animate === "function" &&
                  !grid.classList.contains("masonry-no-anim");
    var moved = 0, positionWrites = 0;

    // 3. Write. One pass; at most one position write per card.
    var prevNode = null;
    places.forEach(function (p) {
      var cat = categoryById.get(p.category);
      var el = cardFor(p, cat ? "var(--category-" + cat.id + ", var(--gold))" : "var(--gold)");
      var slot = next.get(p.id);
      var old = slots.get(p.id);
      var isNew = !attached.has(p.id);

      stopLeaving(p.id, el);
      if (el.parentNode !== grid) grid.appendChild(el);
      attached.set(p.id, el);

      // Keep DOM order == list order (tree reads only; no layout is flushed).
      var want = prevNode ? prevNode.nextSibling : grid.firstChild;
      if (el !== want) grid.insertBefore(el, want);
      prevNode = el;

      el.style.width = r2(colW) + "px";
      if (slot.nameSize) el.style.setProperty("--name-size", r2(slot.nameSize) + "px");
      setWrapWidth(el._atlas.h3, slot.nameWidth);
      setWrapWidth(el._atlas.loc, slot.locWidth);
      setWrapWidth(el._atlas.tag, slot.tagWidth);
      renderTagline(el._atlas.tag, p, slot.tagFlow);

      if (!old || old.left !== slot.left || old.top !== slot.top) {
        el.style.left = slot.left + "px";
        el.style.top = slot.top + "px";
        positionWrites++;
        countWrite(p.id);
      }

      // Expansion: reveal (or hide) the story and field note, and animate the
      // card's own height in the same frame the neighbours are re-slotted.
      var wasExpanded = old ? old.expanded : false;
      var expandEl = el._atlas.expand;
      var heightAnim = null;
      if (slot.expanded) {
        if (expandEl.hidden) expandEl.hidden = false;
        el.style.height = r2(slot.height) + "px";
      } else {
        el.style.removeProperty("height");
      }
      if (animate && old && slot.expanded !== wasExpanded) {
        // Re-toggling mid-flight would otherwise leave two height animations
        // racing, and the loser's finish handler hiding a block that is open.
        if (el._atlasHeightAnim) el._atlasHeightAnim.cancel();
        heightAnim = el.animate(
          [{ height: r2(old.height) + "px" }, { height: r2(slot.height) + "px" }],
          { duration: GLIDE_MS, easing: GLIDE_EASE }
        );
        el._atlasHeightAnim = heightAnim;
        if (slot.expanded) {
          expandEl.animate([{ opacity: 0 }, { opacity: 1 }],
            { duration: 260, delay: 140, easing: "ease-out", fill: "backwards" });
        } else {
          var settle = function () {
            if (expandedId !== p.id) expandEl.hidden = true;
          };
          heightAnim.onfinish = settle;
          heightAnim.oncancel = settle;
        }
      } else if (!slot.expanded && !expandEl.hidden) {
        expandEl.hidden = true;
      }

      // FLIP, in viewport space: the offset also cancels the scroll we are
      // about to apply, so nothing but the page itself appears to jump.
      if (animate && old && !isNew) {
        var dx = old.left - slot.left;
        var dy = old.top - slot.top + scrollDelta;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          if (el._atlasGlide) el._atlasGlide.cancel(); // no stacked glides
          el._atlasGlide = el.animate(
            [{ transform: "translate(" + r2(dx) + "px, " + r2(dy) + "px)" },
             { transform: "none" }],
            { duration: GLIDE_MS, easing: GLIDE_EASE }
          );
          moved++;
        }
      } else if (animate && isNew && el.classList.contains("is-in")) {
        el.animate(
          [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }],
          { duration: ENTER_MS, easing: GLIDE_EASE }
        );
      }

      // Expandable cards are buttons for the keyboard, on the viewports that
      // offer the in-place expansion at all.
      if (canExpand()) {
        if (el.getAttribute("role") !== "button") {
          el.setAttribute("role", "button");
          el.setAttribute("tabindex", "0");
        }
        var ariaNow = slot.expanded ? "true" : "false";
        if (el.getAttribute("aria-expanded") !== ariaNow) {
          el.setAttribute("aria-expanded", ariaNow);
        }
      } else if (el.hasAttribute("role")) {
        el.removeAttribute("role");
        el.removeAttribute("tabindex");
        el.removeAttribute("aria-expanded");
      }
    });

    // 4. Cards the filter dropped: they fade where they stand, then detach.
    var gone = [];
    attached.forEach(function (el, id) { if (!next.has(id)) gone.push(id); });
    gone.forEach(function (id) { detachCard(id, attached.get(id), animate); });

    // 5. Container height, then the scroll compensation — same frame, no paint
    //    in between, so the anchored card never moves on screen.
    var maxH = 0;
    for (var m = 0; m < n; m++) if (colH[m] > maxH) maxH = colH[m];
    var gridH = places.length ? Math.max(0, maxH - GAP) + CHROME.gridPadY : 0;
    grid.style.height = r2(gridH) + "px";
    if (scrollDelta) scrollByInstant(scrollDelta);

    slots = next;
    layoutRuns++;
    lastLayout = {
      columns: n, columnWidth: r2(colW), textWidth: r2(textW),
      cards: places.length, positionWrites: positionWrites, moved: moved,
      scrollDelta: r2(scrollDelta), animated: animate, expanded: expandedId
    };
    if (DEBUG_METRICS) scheduleAgreement();
  }

  // Fallback when pretext is unavailable (or ?noflags=predictiveGrid): the
  // original measured layout, one offsetHeight per card.
  function layoutMeasured(places) {
    grid.textContent = "";
    attached.clear();
    slots.clear();
    var w = viewport.gridWidth || grid.clientWidth;
    if (!w) return;
    if (!places.length) { grid.style.height = "0px"; return; }
    var n = colCountFor(w);
    var colW = (w - GAP * (n - 1)) / n;
    var colH = [];
    for (var i = 0; i < n; i++) colH.push(0);

    var entries = [];
    places.forEach(function (p) {
      var cat = categoryById.get(p.category);
      var el = cardFor(p, cat ? "var(--category-" + cat.id + ", var(--gold))" : "var(--gold)");
      el.style.width = colW + "px";
      grid.appendChild(el); // pooled: re-appending moves the node
      attached.set(p.id, el);
      entries.push({ el: el, h: el.offsetHeight });
    });
    entries.forEach(function (e) {
      var col = 0;
      for (var j = 1; j < n; j++) if (colH[j] < colH[col]) col = j;
      e.el.style.left = (col * (colW + GAP)) + "px";
      e.el.style.top = colH[col] + "px";
      colH[col] += e.h + GAP;
    });
    var maxH = 0;
    for (var k = 0; k < n; k++) if (colH[k] > maxH) maxH = colH[k];
    grid.style.height = Math.max(0, maxH - GAP) + "px";
    layoutRuns++;
    lastLayout = { columns: n, cards: places.length, measured: true };
  }

  // --- The fitted hero headline -----------------------------------------
  // Search the size ladder for the largest size that keeps the headline inside
  // its line budget, then shrink-wrap the box to exactly that many balanced,
  // whole-word lines. Re-run (debounced) on resize.
  var heroTitle = $("hero-title");
  var heroText = heroTitle ? heroTitle.textContent : "";
  var heroFit = null;

  function fitHero() {
    if (!heroTitle || !T || !flag("fitText")) return;
    var vw = viewport.width || 1280;
    var avail = Math.min(1080, vw) - 40; // .wrap: max-width 1080, padding 0 20
    if (avail <= 0) return;
    var maxLines = vw <= 640 ? 3 : 2;    // phones get a third line
    var info;
    try { info = T.fontAt("hero-title", null); }
    catch (e) { return; }
    var ceiling = Math.min(info.fontPx, Math.max(info.fontPx * 0.6, vw * 0.05));
    var floor = info.fontPx * 0.45;
    var chosen = floor, lines = 0;
    for (var s = ceiling; s >= floor - 0.01; s -= 0.5) {
      var lc = T.lineCountOfTextAt("hero-title", heroText, avail, s);
      if (lc <= maxLines) { chosen = s; lines = lc; break; }
    }
    if (!lines) lines = T.lineCountOfTextAt("hero-title", heroText, avail, floor);
    // Never leave a lonely single line: shrink the box until it breaks in two.
    var target = Math.min(maxLines, Math.max(2, lines));
    var boxWidth = Math.min(
      avail,
      Math.ceil(T.tightWidthOfTextAt("hero-title", heroText, avail, chosen, target)) + 1
    );
    heroTitle.style.setProperty("--hero-size", r2(chosen) + "px");
    heroTitle.style.setProperty("--hero-width", boxWidth + "px");
    heroFit = {
      sizePx: r2(chosen),
      lineHeight: r2(T.fontAt("hero-title", chosen).lineHeight),
      lines: target, maxLines: maxLines, maxWidth: boxWidth, available: avail
    };
  }

  // --- Expand a card in place -------------------------------------------
  function toggleExpand(id) {
    if (!canExpand() || !(T && CHROME && flag("predictiveGrid"))) return;
    expandedId = (expandedId === id) ? null : id;
    layoutMasonry();
  }

  // --- Development check: does the prediction match what was painted? ----
  // Compares the predicted top/left/height of every laid-out card against the
  // DOM, and asserts that the shrink-wrapped tagline still wraps to the same
  // number of lines the height was computed from.
  var agreementScheduled = false;
  function scheduleAgreement() {
    if (agreementScheduled) return;
    agreementScheduled = true;
    requestAnimationFrame(function () {
      agreementScheduled = false;
      var res = agreement();
      if (res.warnings) {
        console.warn("[atlas:grid] " + res.warnings +
          " card(s) disagree with the prediction: " + JSON.stringify(res.mismatches));
      }
    });
  }

  function agreement() {
    var out = {
      checked: 0, warnings: 0, mismatches: [],
      topTolerance: 1, heightTolerance: 0,
      maxTopDelta: 0, maxLeftDelta: 0, maxHeightDelta: 0,
      animating: 0, taglineLineMismatches: 0, expanded: expandedId,
      // Phase 4: how many cards are showing a highlighted tagline, and how
      // many of those disagree with the flow that was predicted for them.
      highlighted: 0, taglineFlowMismatches: 0,
      query: state.query,
      predicted: !!(T && CHROME && flag("predictiveGrid")),
      layouts: layoutRuns
    };
    if (!out.predicted) { out.reason = "measured fallback path"; return out; }
    out.heightTolerance = r2(T.fontFor("card-tagline").lineHeight);
    slots.forEach(function (slot, id) {
      var el = cardPool.get(id);
      if (!el || el.parentNode !== grid || el.classList.contains("is-leaving")) return;
      out.checked++;
      var top = el.offsetTop, left = el.offsetLeft, h = el.offsetHeight;
      var dTop = Math.abs(top - slot.top);
      var dLeft = Math.abs(left - slot.left);
      var dH = Math.abs(h - slot.height);
      // A card whose height is mid-animation (an expansion opening or closing)
      // is between two predicted values by design. Its top and left are final
      // — those are written outright — so only the height check waits.
      var busy = el.getAnimations ? el.getAnimations().length > 0 : false;
      if (busy) out.animating++;
      var checkHeight = !slot.expanded && !busy;
      if (dTop > out.maxTopDelta) out.maxTopDelta = r2(dTop);
      if (dLeft > out.maxLeftDelta) out.maxLeftDelta = r2(dLeft);
      // An expanded card is given its height explicitly, so comparing that back
      // would be circular; its neighbours' tops still prove the arithmetic.
      if (checkHeight && dH > out.maxHeightDelta) out.maxHeightDelta = r2(dH);

      var what = null;
      if (dTop > out.topTolerance) what = "top";
      else if (dLeft > out.topTolerance) what = "left";
      else if (checkHeight && dH > out.heightTolerance) what = "height";

      // Shrink-wrapping must never change the line count the height was
      // computed from — that is the whole contract of tightWidth().
      var p = placesById.get(id);
      if (p) {
        var pairs = [];
        if (slot.tagWidth) pairs.push(["card-tagline", p.tagline, slot.tagWidth]);
        if (slot.locWidth) pairs.push(["card-loc", locTextFor(p).toUpperCase(), slot.locWidth]);
        for (var q = 0; q < pairs.length; q++) {
          var full = T.lineCountOfText(pairs[q][0], pairs[q][1], slot.textW);
          var tight = T.lineCountOfText(pairs[q][0], pairs[q][1], pairs[q][2]);
          if (full !== tight) {
            out.taglineLineMismatches++;
            if (!what) what = pairs[q][0] + "-lines";
          }
        }
        if (slot.nameWidth) {
          var nameFull = T.lineCountOfTextAt("card-name", p.name, slot.textW, slot.nameSize);
          var nameTight = T.lineCountOfTextAt("card-name", p.name, slot.nameWidth, slot.nameSize);
          if (nameFull !== nameTight) {
            out.taglineLineMismatches++;
            if (!what) what = "card-name-lines";
          }
        }
        // A highlighted tagline: the DOM has to carry exactly the lines the
        // rich-inline flow predicted, and no line may have re-wrapped (each
        // one is its own block, so a re-wrap would show up as a taller box).
        if (slot.tagFlow) {
          out.highlighted++;
          var tagEl = el._atlas.tag;
          var painted = tagEl.querySelectorAll(".tag-line");
          if (painted.length !== slot.tagFlow.lineCount) {
            out.taglineFlowMismatches++;
            if (!what) what = "card-tagline-flow";
          }
          if (tagEl.scrollWidth > tagEl.clientWidth + 1) {
            out.taglineFlowMismatches++;
            if (!what) what = "card-tagline-overflow";
          }
        }
      }
      if (what) {
        out.warnings++;
        out.mismatches.push({
          id: id, what: what,
          predictedTop: slot.top, actualTop: top,
          predictedLeft: slot.left, actualLeft: left,
          predictedHeight: r2(slot.height), actualHeight: h
        });
      }
    });
    window.ATLAS_GRID_AGREEMENT = out;
    return out;
  }

  // Tell the map which places are visible so its dots dim to match the search.
  function dispatchVisible(places) {
    var ids = new Set(places.map(function (p) { return p.id; }));
    window.ATLAS_VISIBLE = ids; // readable by the map even if it builds late
    if (typeof window.CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("atlas:visible", { detail: ids }));
    }
  }

  // --- Rendering ---------------------------------------------------------
  var firstLayout = true;

  function render() {
    var places = visiblePlaces();
    placeCount.textContent = DATA.places.length + " wonders, " + DATA.categories.length + " regions of wonder";
    resultsStatus.textContent = places.length
      ? "Showing " + places.length + " of " + DATA.places.length + " places."
      : "No results.";
    emptyEl.hidden = places.length !== 0;
    syncStateToUrl();

    // Tell the map which places are currently visible so its dots dim to match.
    dispatchVisible(places);

    if (firstLayout) grid.classList.add("masonry-no-anim");
    layoutMasonry(places);
    if (firstLayout) {
      firstLayout = false;
      // Drop the no-animation guard on the next frame rather than flushing the
      // style with a forced reflow (`void grid.offsetWidth`).
      requestAnimationFrame(function () { grid.classList.remove("masonry-no-anim"); });
    }
  }

  function renderChips() {
    chipsEl.textContent = "";
    var all = document.createElement("button");
    all.type = "button";
    all.className = "chip" + (state.category === "all" ? " active" : "");
    all.textContent = "All";
    all.setAttribute("aria-pressed", String(state.category === "all"));
    all.addEventListener("click", function () { setCategory("all"); });
    chipsEl.appendChild(all);

    DATA.categories.forEach(function (c) {
      var count = DATA.places.filter(function (p) { return p.category === c.id; }).length;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (state.category === c.id ? " active" : "");
      b.textContent = c.label + " · " + count;
      b.style.setProperty("--chip-accent", "var(--category-" + c.id + ", var(--gold))");
      b.setAttribute("aria-pressed", String(state.category === c.id));
      b.addEventListener("click", function () { setCategory(c.id); });
      chipsEl.appendChild(b);
    });
  }

  function setCategory(id) {
    state.category = id;
    renderChips();
    render();
  }

  // --- Locate me (geolocation → nearest wonder + distance sort) ----------
  var sortSelectEl = $("sort-select");
  function setDistanceSort() {
    var opt = sortSelectEl.querySelector('option[value="distance"]');
    if (!opt) return;
    opt.disabled = false;
    sortSelectEl.value = "distance";
    state.sort = "distance";
    render();
  }
  function locateMe() {
    if (!navigator.geolocation) return;
    var btn = $("map-locate");
    if (btn) { btn.textContent = "⌖ Locating…"; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (btn) btn.textContent = "⌖ You're here ✓";
      // Tell the map where the visitor is (it draws the marker + nearest wonder).
      if (typeof window.CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("atlas:locate", {
          detail: { lat: pos.coords.latitude, lon: pos.coords.longitude }
        }));
      }
      setDistanceSort();
    }, function () {
      if (btn) btn.textContent = "⌖ Locate me";
      if (typeof window.CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("atlas:locate-error"));
      }
    }, { timeout: 10000, maximumAge: 600000 });
  }

  // --- Surprise me (random place within the current filter) ---------------
  function surpriseMe() {
    var list = visiblePlaces();
    if (!list.length) return;
    var p = list[(Math.random() * list.length) | 0];
    location.hash = hashForPlace(p.id);
  }

  // --- Daily pick --------------------------------------------------------
  function renderDaily() {
    var p = DATA.places[dailyIndex()];
    var cat = categoryById.get(p.category);
    var card = $("daily-card");
    card.textContent = "";
    card.style.setProperty("--card-accent", cat ? "var(--category-" + cat.id + ", var(--gold))" : "var(--gold)");

    var sym = document.createElement("span");
    sym.className = "card-symbol daily-symbol";
    sym.textContent = p.symbol;
    sym.setAttribute("aria-hidden", "true");
    var name = document.createElement("span");
    name.className = "daily-name";
    name.textContent = p.name + " — " + p.country;
    var tag = document.createElement("span");
    tag.className = "daily-tag";
    tag.textContent = p.tagline;
    var go = document.createElement("span");
    go.className = "daily-go";
    go.textContent = "Open →";

    card.appendChild(sym);
    card.appendChild(name);
    card.appendChild(tag);
    card.appendChild(go);
    card.addEventListener("click", function () { location.hash = hashForPlace(p.id); });
  }

  // --- Dialog -------------------------------------------------------------
  // Phase 3 moved the dialog's rendering into js/dialog.js (an ES module that
  // runs before this file and publishes window.ATLAS_DIALOG). Everything below
  // delegates to it when it is there and keeps the original plain rendering as
  // the fallback for when it is not — a missing metrics module, ?noflags=
  // editorial, or an old browser.
  var DLG = window.ATLAS_DIALOG || null;
  if (DLG) DLG.setVisibleProvider(visiblePlaces);

  // --- The field guide ---------------------------------------------------
  // Phase 6's js/reader.js is another ES module that runs before this file.
  // It paginates whatever the current filter shows, so it reads the visible
  // list through the same provider the dialog uses.
  var RDR = window.ATLAS_READER || null;
  if (RDR) RDR.setVisibleProvider(visiblePlaces);

  function openReader(id) { if (RDR) RDR.open(id); }
  function closeReader() { if (RDR && RDR.isOpen()) RDR.close(); }

  var dialogIndex = 0; // position within the current visible list
  var currentPlaceId = null; // id of the place the dialog is showing (for sharing)

  function dialogPlaceId() { return DLG ? DLG.currentId() : currentPlaceId; }

  function openDialog(id) {
    if (DLG) { DLG.open(id); return; }
    openDialogPlain(id);
  }

  function closeDialog() {
    if (DLG) { DLG.close(); return; }
    currentPlaceId = null;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function stepDialog(dir) {
    if (DLG) { DLG.step(dir); return; }
    var list = visiblePlaces();
    if (!list.length) return;
    dialogIndex = (dialogIndex + dir + list.length) % list.length;
    openDialogPlain(list[dialogIndex].id);
  }

  // The pre-Phase-3 rendering: one paragraph, no spread. Kept verbatim so the
  // dialog still works with the editorial module absent.
  function openDialogPlain(id) {
    var p = placesById.get(id);
    if (!p) return;
    var cat = categoryById.get(p.category);

    $("dialog-symbol").textContent = p.symbol;
    $("dialog-symbol").style.color = cat ? "var(--category-" + cat.id + ", var(--gold))" : "var(--gold)";
    var badge = $("dialog-category");
    badge.textContent = cat ? cat.label : "";
    badge.style.setProperty("--card-accent", cat ? "var(--category-" + cat.id + ", var(--gold))" : "var(--gold)");
    $("dialog-title").textContent = p.name;
    $("dialog-loc").textContent = p.country + " — " + p.region;
    $("dialog-tagline").textContent = p.tagline;
    $("dialog-story").textContent = p.story;
    $("dialog-fact").textContent = p.fact;
    $("dialog-besttime").textContent = p.bestTime || "";
    $("dialog-nearest").textContent = p.nearestCity || "";
    $("dialog-coords").textContent = "≈ " + p.coordinates;
    currentPlaceId = p.id;

    // Ask the map to pulse this place's dot so the grid and the map stay linked.
    if (typeof window.CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("atlas:highlight", { detail: p.id }));
    }

    dialogIndex = visiblePlaces().indexOf(p);
    if (dialogIndex < 0) dialogIndex = 0;

    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", ""); // very old browser fallback
    }
  }

  // --- Hash routing: #/place/<id> and #/read/<id> -------------------------
  // The two are exclusive: opening the field guide closes the dialog, and
  // leaving either route closes what it opened. The reader rewrites the hash
  // with history.replaceState as pages turn, which fires no hashchange, so
  // turning a page never re-enters this function.
  function route() {
    var r = /^#\/read\/(.+)$/.exec(location.hash);
    if (r && RDR) {
      var rid = decodeURIComponent(r[1]);
      if (placesById.has(rid)) {
        closeDialog();
        openReader(rid);
        return;
      }
    }
    closeReader();
    var m = /^#\/place\/(.+)$/.exec(location.hash);
    if (m) {
      var id = decodeURIComponent(m[1]);
      if (placesById.has(id)) {
        openDialog(id);
        return;
      }
    }
    closeDialog();
  }

  // --- Share link -----------------------------------------------------------
  // When the static build has generated per-place pages (places/<id>/), the
  // share link points at that real, indexable URL; otherwise it falls back to
  // the hash deep-link on the main page. We probe the page once (same-origin,
  // which the CSP permits) and cache the answer.
  var placePagesKnown = "hasPlacePages" in window && window.hasPlacePages === true ? true : null;
  function siteRoot() {
    // origin + path of this page with the filename stripped (no query, no
    // hash) → the base directory. Correct on any static-host path.
    var p = location.pathname || "/";
    if (p.charAt(p.length - 1) !== "/") p = p.replace(/[^/]+$/, "");
    return (location.origin === "null" ? "" : location.origin) + p;
  }
  function placePageUrl(id) {
    var root = siteRoot();
    if (placePagesKnown === true) return root + "places/" + encodeURIComponent(id) + "/";
    return root + hashForPlace(id);
  }
  function sharePlace(id) {
    var btn = $("dialog-share");
    var finish = function (full) {
      var original = "Copy link";
      btn.textContent = "Link copied ✓";
      setTimeout(function () { btn.textContent = original; }, 1500);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(full).catch(function () { prompt("Copy this link:", full); });
      } else {
        prompt("Copy this link:", full);
      }
    };
    if (placePagesKnown !== null || location.origin === "null") {
      finish(placePageUrl(id)); // known, or file:// (can't probe)
      return;
    }
    fetch("places/" + encodeURIComponent(id) + "/", { method: "HEAD" })
      .then(function (r) { placePagesKnown = r.ok; })
      .catch(function () { placePagesKnown = false; })
      .then(function () { finish(placePageUrl(id)); });
  }

  // --- Wiring ---------------------------------------------------------------
  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = searchInput.value;
      render();
    }, 120);
  });
  searchForm.addEventListener("submit", function (e) {
    e.preventDefault(); // never navigate away from the page
    state.query = searchInput.value;
    render();
    searchInput.blur();
  });
  sortSelect.addEventListener("change", function () {
    // Distance sorting needs a fix from "Locate me" first.
    if (sortSelect.value === "distance" && !state.userLoc) {
      sortSelect.value = state.sort; // revert the visual choice
      locateMe();
      return;
    }
    state.sort = sortSelect.value;
    render();
  });

  // New control wiring: locate me + surprise me.
  var locateBtn = $("map-locate");
  if (locateBtn) locateBtn.addEventListener("click", locateMe);
  var surpriseBtn = $("surprise-btn");
  if (surpriseBtn) surpriseBtn.addEventListener("click", surpriseMe);

  // "Read as a book": the field guide, opened at the first place of the
  // current filter and deep-linkable from there. Without js/reader.js (no
  // metrics module, or ?noflags=bookMode) the control is not offered at all.
  var readBookBtn = $("read-book-btn");
  if (readBookBtn && !RDR) readBookBtn.hidden = true;
  if (readBookBtn && RDR) {
    readBookBtn.addEventListener("click", function () {
      var list = visiblePlaces();
      if (!list.length) return;
      var target = hashForRead(list[0].id);
      // Assigning the same hash fires no hashchange, so open it directly.
      if (location.hash === target) openReader(list[0].id);
      else location.hash = target;
    });
  }

  // Delegated click on the grid: card links are <a href="#/place/...">,
  // so no per-card listeners are needed at all.
  $("dialog-close").addEventListener("click", closeDialog);
  $("dialog-prev").addEventListener("click", function () { stepDialog(-1); });
  $("dialog-next").addEventListener("click", function () { stepDialog(1); });
  $("dialog-share").addEventListener("click", function () {
    var id = dialogPlaceId();
    if (id) sharePlace(id);
  });

  // Clicking the dialog backdrop (the <dialog> itself, not its contents) closes it.
  dialog.addEventListener("click", function (e) {
    var r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      closeDialog();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (!dialog.open) return;
    if (e.key === "Escape") closeDialog();
    if (e.key === "ArrowLeft") stepDialog(-1);
    if (e.key === "ArrowRight") stepDialog(1);
  });

  window.addEventListener("hashchange", route);

  // --- Grid interaction: hover anchor + expand in place -------------------
  // The pointer's last card is remembered (not cleared on mouseleave): a chip
  // click or a keystroke happens with the pointer somewhere else entirely, and
  // that card is still the one the reader was looking at. It only counts as an
  // anchor while it is still in the filtered list.
  grid.addEventListener("mouseover", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var card = t.closest(".card[data-place-id]");
    if (card && !card.classList.contains("is-leaving")) {
      hoverId = card.getAttribute("data-place-id");
    }
  });

  grid.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("a")) return; // "Read the field note →" still opens the dialog
    var card = t.closest(".card[data-place-id]");
    if (!card || card.classList.contains("is-leaving")) return;
    if (!canExpand()) return;   // phones (and deep links) keep the modal
    toggleExpand(card.getAttribute("data-place-id"));
  });

  grid.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    var t = e.target;
    if (!t || !t.closest || t.tagName === "A") return;
    var card = t.closest('.card[role="button"][data-place-id]');
    if (!card) return;
    e.preventDefault(); // Space must not scroll the page
    toggleExpand(card.getAttribute("data-place-id"));
  });

  // Re-layout the masonry when the viewport width changes (column count /
  // column widths can change) and refit the headline. Debounced; the viewport
  // is re-read here, never inside layoutMasonry().
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      readViewport();
      fitHero();
      layoutMasonry(null, { noAnchor: true });
    }, 120);
  });

  // If pretext boots late (or is re-published), pick it up and switch to the
  // predictive path instead of staying on the measured fallback.
  window.addEventListener("atlas:text-ready", function (e) {
    if (T || !(e.detail && e.detail.metrics)) return;
    T = e.detail.metrics;
    FLAGS = window.ATLAS_FLAGS || FLAGS;
    registerCardText();
    readViewport();
    CHROME = readChrome();
    fitHero();
    slots = new Map();
    render();
  });

  // Development / smoke-test surface. Everything here reads the layout's own
  // bookkeeping; `agreement()` is the only part that touches the DOM.
  window.ATLAS_GRID_DEBUG = {
    agreement: agreement,
    lastLayout: function () { return lastLayout; },
    layouts: function () { return layoutRuns; },
    chrome: function () { return CHROME; },
    hero: function () { return heroFit; },
    flags: function () { return FLAGS; },
    slots: function () {
      var out = {};
      slots.forEach(function (s, id) { out[id] = s; });
      return out;
    },
    // Position writes per card id, so "every card moved exactly once" is a
    // countable claim rather than an impression.
    writes: function () {
      var out = {};
      writeCounts.forEach(function (n, id) { out[id] = n; });
      return out;
    },
    resetWrites: function () { writeCounts = new Map(); },
    // Phase 4: drive the search from a test without going through the
    // debounced input handler, and read back what each tagline was flowed to.
    setQuery: function (q) {
      state.query = String(q == null ? "" : q);
      searchInput.value = state.query;
      render();
      return state.query;
    },
    query: function () { return state.query; },
    flows: function () {
      var out = {};
      slots.forEach(function (s, id) {
        if (!s.tagFlow) return;
        out[id] = {
          lines: s.tagFlow.lineCount, width: r2(s.tagFlow.width),
          lineHeight: r2(s.tagFlow.lineHeight),
          maxLineWidth: r2(s.tagFlow.maxLineWidth),
          matches: s.tagFlow.matches
        };
      });
      return out;
    },
    natives: function () {
      var out = {};
      slots.forEach(function (s, id) {
        if (s.native) out[id] = s.native;
      });
      return out;
    },
    expandedId: function () { return expandedId; },
    anchorId: anchorId,
    setHover: function (id) { hoverId = id; },
    toggleExpand: toggleExpand,
    relayout: function () { layoutMasonry(); }
  };

  // --- Init -----------------------------------------------------------------
  restoreStateFromUrl();
  searchInput.value = state.query;
  sortSelect.value = state.sort;
  if (state.sort === "distance" && !state.userLoc) sortSelect.value = "featured"; // no fix yet
  setupReveal();
  registerCardText();
  readViewport();
  CHROME = readChrome();   // the one and only chrome measurement pass
  fitHero();
  placeCount.textContent = DATA.places.length + " wonders across " + new Set(DATA.places.map(function (p) { return p.country; })).size + " countries";
  renderChips();
  renderDaily();
  render();
  route();
  // Service worker (offline cache). Only on http(s) — file:// can't register.
  // Register at (or after) load so the page's own resources are served first.
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
    var regSw = function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline cache is best-effort */ });
    };
    if (document.readyState === "complete") regSw();
    else window.addEventListener("load", regSw);
  }
})();
