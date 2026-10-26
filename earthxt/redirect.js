/* The globe lives inside the atlas now (index.html#/globe), beside the flat
   map. This page stays as the globe's test bench (?bench) and as the template
   of the offline single-file edition, so only a plain visit is sent on, with
   its place deep link translated: #/place/<id> → #/globe/place/<id>. */
(function () {
  if (document.documentElement.hasAttribute("data-standalone")) return;
  if (/[?&]bench(?:[=&]|$)/.test(location.search)) return;
  var place = /^#\/place\/([^/]+)$/.exec(location.hash);
  location.replace("../" + (place ? "#/globe/place/" + place[1] : "#/globe"));
})();
