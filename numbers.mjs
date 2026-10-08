// Spoken Persian numbers → digits, and digits → natural Persian read-back.
// Iranians say long numbers in groups: «صفر نهصد و دوازده، سیصد و چهل و پنج، شصت و هفت، هشتاد و نه» = 09123456789.
// Inside a group, parts are joined by «و» («نود و هفت» = 97); a number word NOT preceded by «و» starts a
// new group («صد بیست سی» = 100|20|30). Speech-to-text drops the commas, so this rule is what separates groups.
// Doing this in code (not in the model's head) keeps 10–11 digit numbers exact.

const UNITS = { "صفر": 0, "یک": 1, "یه": 1, "دو": 2, "سه": 3, "چهار": 4, "چار": 4, "پنج": 5, "شش": 6, "شیش": 6, "هفت": 7, "هشت": 8, "نه": 9 };
const TEENS = { "ده": 10, "یازده": 11, "دوازده": 12, "سیزده": 13, "چهارده": 14, "پانزده": 15, "پونزده": 15, "شانزده": 16, "شونزده": 16,
  "هفده": 17, "هیفده": 17, "هجده": 18, "هیجده": 18, "هژده": 18, "نوزده": 19 };
const TENS = { "بیست": 20, "سی": 30, "چهل": 40, "پنجاه": 50, "پنجا": 50, "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90 };
const HUNDREDS = { "صد": 100, "یکصد": 100, "دویست": 200, "سیصد": 300, "چهارصد": 400, "پانصد": 500, "پونصد": 500,
  "ششصد": 600, "شیشصد": 600, "هفتصد": 700, "هشتصد": 800, "نهصد": 900 };

function wordValue(w) {
  if (w in UNITS) return { v: UNITS[w], place: 1 };
  if (w in TEENS) return { v: TEENS[w], place: 1 };   // a teen closes the tens+units slots
  if (w in TENS) return { v: TENS[w], place: 10 };
  if (w in HUNDREDS) return { v: HUNDREDS[w], place: 100 };
  return null;
}

const normalize = (s) => String(s)
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[ي]/g, "ی").replace(/[ك]/g, "ک").replace(/‌/g, " ")
  .replace(/[،,.؛;:!?؟«»()\-–—_/]/g, " ");

// Returns every run of spoken numbers in the text: [{ digits: "09123456789", groups: ["0","912","345","67","89"] }].
// A run ends at any non-number word, so "صفر نهصد … ببخشید … " yields two runs.
export function extractNumbers(text) {
  const tokens = normalize(text).split(/\s+/).filter(Boolean);
  const runs = [];
  let groups = [], cur = null, joiner = false;
  const flush = () => { if (cur) groups.push(String(cur.v)); cur = null; joiner = false; };
  const endRun = () => { flush(); if (groups.length) runs.push({ digits: groups.join(""), groups }); groups = []; };
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (t.startsWith("و") && t.length > 1 && wordValue(t.slice(1))) { joiner = !!cur; t = t.slice(1); }   // «وپنج»
    if (t === "و") { if (cur) joiner = true; continue; }
    if (/^\d+$/.test(t)) { flush(); groups.push(t); continue; }                          // STT already wrote digits
    if (t === "تا" && tokens[i + 1] === "صفر" && cur && cur.minPlace === 0 && cur.v <= 9) {  // «دو تا صفر» = 00
      groups.push("0".repeat(cur.v)); cur = null; joiner = false; i++; continue;
    }
    if (t === "صفر") { flush(); groups.push("0"); continue; }
    const wv = wordValue(t);
    if (!wv) { endRun(); continue; }
    if (cur && joiner && wv.place < cur.minPlace) { cur.v += wv.v; cur.minPlace = wv.place === 1 ? 0 : wv.place; joiner = false; }
    else { flush(); cur = { v: wv.v, minPlace: wv.place === 1 ? 0 : wv.place }; }
  }
  endRun();
  return runs;
}

/* ---------- digits → Persian words (for natural read-back) ---------- */
const W1 = ["صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"];
const W10 = ["ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"];
const W20 = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const W100 = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];
function under1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(W100[Math.floor(n / 100)]); n %= 100; }
  if (n >= 20) { parts.push(W20[Math.floor(n / 10)]); n %= 10; if (n) parts.push(W1[n]); }
  else if (n >= 10) parts.push(W10[n - 10]);
  else if (n > 0) parts.push(W1[n]);
  return parts.join(" و ") || W1[0];
}
// One group as it's spoken: leading zeros are said one by one («صفر نود و هشت» for "098").
function groupWords(g) {
  const lead = g.match(/^0*/)[0].length;
  const rest = g.slice(lead);
  return [...Array(lead).fill("صفر"), ...(rest ? [under1000(Number(rest))] : [])].join(" ");
}
// Groups for read-back: keep the caller's own groups when they're short; split long digit blocks the usual way
// (mobile 0912-345-67-89, national ID 001-234-567-9).
function readbackGroups(run) {
  const out = [];
  for (const g of run.groups) {
    if (g.length <= 3) { out.push(g); continue; }
    if (g.length === 11 && g.startsWith("09")) out.push("0", g.slice(1, 4), g.slice(4, 7), g.slice(7, 9), g.slice(9));
    else if (g.length === 4 && g.startsWith("09")) out.push("0", g.slice(1));
    else for (let i = 0; i < g.length; i += 3) out.push(g.slice(i, i + 3));
  }
  return out;
}
export const sayDigits = (run) => readbackGroups(run).map(groupWords).join("، ");

export function validCodeMelli(v) {
  if (!/^\d{10}$/.test(v) || /^(\d)\1{9}$/.test(v)) return false;
  let s = 0; for (let i = 0; i < 9; i++) s += (+v[i]) * (10 - i);
  const r = s % 11, c = +v[9];
  return r < 2 ? c === r : c === 11 - r;
}

// A note for the model when the caller's turn contains a long number (≥ 4 digits), or "" if none.
// «نه» is also "no": «نه، صفر نهصد و…» parses as a leading 9. Drop it when that leaves a proper mobile/ID.
function dropLeadingNo(r) {
  if (r.groups[0] !== "9" || r.groups.length < 2) return r;
  const rest = { digits: r.digits.slice(1), groups: r.groups.slice(1) };
  const fits = (d) => (d.length === 11 && d.startsWith("09")) || (d.length === 10 && validCodeMelli(d));
  return fits(rest.digits) && !fits(r.digits) ? rest : r;
}

export function numberNote(text) {
  const runs = extractNumbers(text).map(dropLeadingNo).filter((r) => r.digits.length >= 4);
  if (!runs.length) return "";
  const lines = runs.map((r) => {
    const n = r.digits.length;
    const kind = n === 11 && r.digits.startsWith("09") ? "looks like a valid Iranian mobile"
      : n === 10 ? (validCodeMelli(r.digits) ? "valid national-ID checksum" : "10 digits but FAILS the national-ID checksum")
      : `${n} digits — not a complete mobile (11) or national ID (10)`;
    return `digits ${r.digits} (${n} digits; ${kind}); read back as: «${sayDigits(r)}»`;
  });
  return `[Number parser (exact; trust it over your own reading of the words): ${lines.join(" | ")}]`;
}
