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

  function cardFor(p, accent) {
    var existing = cardPool.get(p.id);
    if (existing) {
      existing.style.setProperty("--card-accent", accent);
      return existing;
    }
    var card = document.createElement("article");
    card.className = "card";
    card.style.setProperty("--card-accent", accent);
    card.setAttribute("data-place-id", p.id);

    var sym = document.createElement("span");
    sym.className = "card-symbol";
    sym.textContent = p.symbol;
    sym.setAttribute("aria-hidden", "true");

    var h = document.createElement("h3");
    h.className = "card-name";
    h.textContent = p.name;

    var loc = document.createElement("p");
    loc.className = "card-loc";
    loc.textContent = p.country + " · " + p.region;

    var tag = document.createElement("p");
    tag.className = "card-tag";
    tag.textContent = p.tagline;

    var link = document.createElement("a");
    link.className = "card-more";
    link.href = hashForPlace(p.id);
    link.textContent = "Read the field note →";

    card.appendChild(sym);
    card.appendChild(h);
    card.appendChild(loc);
    card.appendChild(tag);
    card.appendChild(link);
    cardPool.set(p.id, card);
    if (masonryIO) masonryIO.observe(card);
    else card.classList.add("is-in");
    return card;
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

  function layoutMasonry() {
    var places = visiblePlaces();
    var w = grid.clientWidth;
    if (!w) return;
    if (!places.length) { grid.style.height = "0px"; return; }
    var n = colCountFor(w);
    var colW = (w - GAP * (n - 1)) / n;
    var colH = [];
    for (var i = 0; i < n; i++) colH.push(0);

    var entries = [];
    places.forEach(function (p) {
      var cat = categoryById.get(p.category);
      var el = cardFor(p, cat ? cat.accent : "#e8b45a");
      el.style.width = colW + "px";
      grid.appendChild(el); // pooled: re-appending moves the node
      entries.push({ el: el, h: el.offsetHeight });
    });
    entries.forEach(function (e) {
      var col = 0;
      for (var i = 1; i < n; i++) if (colH[i] < colH[col]) col = i;
      e.el.style.left = (col * (colW + GAP)) + "px";
      e.el.style.top = colH[col] + "px";
      colH[col] += e.h + GAP;
    });
    var maxH = 0;
    for (var j = 0; j < n; j++) if (colH[j] > maxH) maxH = colH[j];
    grid.style.height = Math.max(0, maxH - GAP) + "px";
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
    grid.textContent = ""; // detach pooled cards; layoutMasonry re-appends
    var places = visiblePlaces();
    placeCount.textContent = DATA.places.length + " wonders, " + DATA.categories.length + " regions of wonder";
    resultsStatus.textContent = places.length
      ? "Showing " + places.length + " of " + DATA.places.length + " places."
      : "No results.";
    emptyEl.hidden = places.length !== 0;
    syncStateToUrl();

    // Tell the map which places are currently visible so its dots dim to match.
    dispatchVisible(places);

    if (firstLayout) {
      grid.classList.add("masonry-no-anim");
      firstLayout = false;
    }
    layoutMasonry();
    if (grid.classList.contains("masonry-no-anim")) {
      void grid.offsetWidth; // flush, then re-enable transitions
      grid.classList.remove("masonry-no-anim");
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
      b.style.setProperty("--chip-accent", c.accent);
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
    card.style.setProperty("--card-accent", cat ? cat.accent : "#e8b45a");

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
  var dialogIndex = 0; // position within the current visible list
  var currentPlaceId = null; // id of the place the dialog is showing (for sharing)

  function openDialog(id) {
    var p = placesById.get(id);
    if (!p) return;
    var cat = categoryById.get(p.category);

    $("dialog-symbol").textContent = p.symbol;
    $("dialog-symbol").style.color = cat ? cat.accent : "#e8b45a";
    var badge = $("dialog-category");
    badge.textContent = cat ? cat.label : "";
    badge.style.setProperty("--card-accent", cat ? cat.accent : "#e8b45a");
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

  function closeDialog() {
    currentPlaceId = null;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function stepDialog(dir) {
    var list = visiblePlaces();
    if (!list.length) return;
    dialogIndex = (dialogIndex + dir + list.length) % list.length;
    openDialog(list[dialogIndex].id);
  }

  // --- Hash routing: #/place/<id> ----------------------------------------
  function route() {
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

  // Delegated click on the grid: card links are <a href="#/place/...">,
  // so no per-card listeners are needed at all.
  $("dialog-close").addEventListener("click", closeDialog);
  $("dialog-prev").addEventListener("click", function () { stepDialog(-1); });
  $("dialog-next").addEventListener("click", function () { stepDialog(1); });
  $("dialog-share").addEventListener("click", function () {
    if (currentPlaceId) sharePlace(currentPlaceId);
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

  // Re-layout the masonry when the viewport width changes (column count /
  // column widths can change). Debounced; cheap on an idle page.
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { layoutMasonry(); }, 120);
  });

  // --- Init -----------------------------------------------------------------
  restoreStateFromUrl();
  searchInput.value = state.query;
  sortSelect.value = state.sort;
  if (state.sort === "distance" && !state.userLoc) sortSelect.value = "featured"; // no fix yet
  setupReveal();
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
