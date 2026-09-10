/* Atlas of the Curious — the visitor's notebook: storage and the postcard.

   Two callers share this file: js/dialog.js, which owns the textarea, and
   js/reader.js, which sets the saved note (read-only) at the end of a place's
   pages in the field guide.

   The privacy contract, stated once here because both callers depend on it:

     - a note never enters the URL (the reader's `#/read/<id>` route carries a
       place id and nothing else),
     - a note never enters the generated `places/<id>/` share pages — those are
       built by scripts/build-place-pages.mjs from js/data.js, in Node, long
       before any browser has a note to give it,
     - a note never enters a request. The only sink is `localStorage`, keyed by
       place id.

   Every access is wrapped, and not only the call: a browser in private mode or
   with site data blocked throws on the `localStorage` *property* itself. */

export const NOTE_KEY_PREFIX = "atlas:note:";

// A generous ceiling. A note is a paragraph or two, and an unbounded string
// would be a way to fill a visitor's storage quota by accident.
export const NOTE_MAX = 4000;

export function noteKey(id) { return NOTE_KEY_PREFIX + String(id == null ? "" : id); }

function storageOf(win) {
  try { return (win && win.localStorage) || null; } catch (e) { return null; }
}

export function readNote(win, id) {
  const store = storageOf(win);
  if (!store || !id) return "";
  try {
    const value = store.getItem(noteKey(id));
    return typeof value === "string" ? value : "";
  } catch (e) { return ""; }
}

// Returns whether the write actually landed, so the caller can say "Saved"
// honestly rather than optimistically.
export function writeNote(win, id, text) {
  const store = storageOf(win);
  if (!store || !id) return false;
  const str = String(text == null ? "" : text).slice(0, NOTE_MAX);
  try {
    if (!str) store.removeItem(noteKey(id));
    else store.setItem(noteKey(id), str);
    return true;
  } catch (e) { return false; }
}

export function clearNote(win, id) { return writeNote(win, id, ""); }

/* The plain-text postcard the "Copy as postcard" button puts on the clipboard.

     <name>
     <native name>            — only when it is genuinely a second name
     <country>
     <coordinates>
                              — a blank line
     <the note, verbatim>     — the visitor's own line breaks and tabs
                              — a blank line
     — Atlas of the Curious

   Only trailing whitespace is trimmed off the note; everything inside it is
   the visitor's and is copied through untouched. */
export function postcardText(place, note) {
  const p = place || {};
  const out = [];
  out.push(String(p.name || ""));
  const native = String(p.nativeName || "");
  if (native && native !== p.name) out.push(native);
  out.push(String(p.country || ""));
  out.push(String(p.coordinates || ""));
  const body = String(note == null ? "" : note).replace(/\s+$/, "");
  if (body) { out.push(""); out.push(body); }
  out.push("");
  out.push("— Atlas of the Curious");
  return out.join("\n");
}
