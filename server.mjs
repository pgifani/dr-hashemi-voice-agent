// Persian voice receptionist for Dr. Hashemi's clinic (prototype: web voice, turn-based).
//   Browser mic → POST /api/turn (one utterance) → STT → Claude + tools → TTS → MP3 + text back.
// Bookings go through the clinic website's API (BOOKING_API_BASE) so the live SMS + staff pipeline is reused.
//
// Zero npm dependencies; Node 22+. Configuration in voice-agent/.env or the workspace ../.env:
//   ANTHROPIC_API_KEY=...          dialogue brain (required for real conversations)
//   VOICE_MODEL=claude-sonnet-5-5  VOICE_EFFORT=low   (fastest good Persian in tests, ~2 s per reply)
//   ELEVENLABS_API_KEY=...         speech-to-text + text-to-speech
//   ELEVENLABS_VOICE_ID=...        a voice that sounds natural in Persian (pick in the Voice Library)
//   STT_MODEL=scribe_v2  STT_LANGUAGE=fas  TTS_MODEL=eleven_v3
//   BOOKING_API_BASE=http://localhost:3000   (the clinic website; https://<clinic domain> in production)
//   PORT=3100

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createSpeech } from "./speech.mjs";
import { createAgent, createBooking, GREETING } from "./agent.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

function loadEnv() {   // values are never logged
  const env = { ...process.env };
  for (const p of [join(ROOT, ".env"), join(ROOT, "..", ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const ENV = loadEnv();
const PORT = Number(ENV.PORT) || 3100;
const speech = createSpeech(ENV);
const booking = createBooking(ENV.BOOKING_API_BASE || "http://localhost:3000");
const agent = createAgent(ENV, booking);

/* ---------- sessions (in memory; transcripts are never written to disk) ---------- */
const SESSION_TTL = 20 * 60000, MAX_TURNS = 40, MAX_AUDIO = 3 * 1024 * 1024;
const sessions = new Map();
setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.seen > SESSION_TTL) sessions.delete(id); }, 60000).unref();
function newSession() {
  const s = { id: randomUUID(), messages: [], slots: null, booked: 0, turns: 0, ended: false, busy: false, seen: Date.now() };
  sessions.set(s.id, s);
  return s;
}

/* ---------- per-IP rate limits ---------- */
const hits = new Map();
function rateOk(ip, kind, max, win) {
  const k = kind + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < win);
  if (arr.length >= max) { hits.set(k, arr); return false; }
  arr.push(now); hits.set(k, arr);
  if (hits.size > 10000) hits.clear();
  return true;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Light cleanup so TTS doesn't read symbols aloud.
const speakableBase = (t) => String(t).replace(/[*_#`>|~]/g, "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
// Pronunciation fixes taught by staff (/say هاشمی = هاشِمی), applied to whole words just before speech.
let sayRules = [];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const speakable = (t) => sayRules.reduce((out, { word, as }) =>
  out.replace(new RegExp(`(^|[^\\p{L}\\p{M}])${escapeRe(word)}(?=$|[^\\p{L}\\p{M}])`, "gu"), `$1${as}`), speakableBase(t));
// Words the recognizer should expect: the clinic's own names plus every word staff taught a pronunciation for.
const BASE_TERMS = ["هاشمی", "فروغ", "گوهردشت", "کرج", "کد ملی", "نوبت"];
async function refreshKnowledge() {
  const k = await booking.knowledge();
  sayRules = (k.say || []).filter((r) => r.word && r.as);
  return [...new Set([...BASE_TERMS, ...sayRules.map((r) => r.word)])];
}

async function speak(text) {
  try { const mp3 = await speech.synthesize(speakable(text)); return mp3 ? mp3.toString("base64") : null; }
  catch (e) { console.error("tts failed:", e.message); return null; }
}

// Fixed phrases (greeting, "didn't catch that", error) never change, so each is synthesized once and reused.
const phraseCache = new Map();
async function cachedSpeak(text) {
  if (!speech.ttsOn) return null;
  if (!phraseCache.has(text)) { const a = await speak(text); if (a) phraseCache.set(text, a); return a; }
  return phraseCache.get(text);
}
const greeting = () => cachedSpeak(GREETING);
const NOT_HEARD = "ببخشید، صداتون رو واضح نشنیدم. میشه دوباره بفرمایید؟";
const TECH_ERROR = "ببخشید، یه مشکل فنی پیش اومد. لطفاً دوباره بفرمایید، یا با شماره‌ی مطب تماس بگیرید.";

/* ---------- streamed replies: synthesis starts the moment the reply text exists; the page plays
   /api/tts/<id> while chunks are still arriving, instead of waiting for the whole MP3 ---------- */
const ttsJobs = new Map();
setInterval(() => { const old = Date.now() - 3 * 60000; for (const [id, j] of ttsJobs) if (j.created < old) ttsJobs.delete(id); }, 60000).unref();
function startTts(text) {
  if (!speech.ttsOn || !text) return null;
  const id = randomUUID();
  const job = { chunks: [], done: false, failed: false, waiters: new Set(), created: Date.now() };
  ttsJobs.set(id, job);
  const wake = () => { for (const w of [...job.waiters]) w(); };
  (async () => {
    try { for await (const c of speech.streamSynthesize(speakable(text))) { job.chunks.push(c); wake(); } }
    catch (e) { job.failed = true; console.error("tts stream failed:", e.message); }
    job.done = true; wake();
  })();
  return `/api/tts/${id}`;
}
async function handleTtsStream(req, res, id) {
  const job = ttsJobs.get(id);
  if (!job) { res.writeHead(404); return res.end(); }
  const next = () => new Promise((r) => { const w = () => { job.waiters.delete(w); r(); }; job.waiters.add(w); });
  while (!job.chunks.length && !job.done) await next();   // hold the headers until audio actually exists
  if (!job.chunks.length) { res.writeHead(502); return res.end(); }
  res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
  let i = 0;
  for (;;) {
    while (i < job.chunks.length) res.write(job.chunks[i++]);
    if (job.done || res.destroyed) break;
    await next();
  }
  res.end();
}

// Optional private-link gate for testing: with ACCESS_CODE set, calls only start from <url>/?k=<code>.
const ACCESS_CODE = (ENV.ACCESS_CODE || "").trim();

// POST /api/start → new session + spoken greeting.
async function handleStart(req, res) {
  if (ACCESS_CODE && new URL(req.url, "http://x").searchParams.get("k") !== ACCESS_CODE) return json(res, 403, { ok: false, error: "access" });
  if (!rateOk(clientIp(req), "s", 10, 3600000)) return json(res, 429, { ok: false, error: "rate" });
  const s = newSession();
  json(res, 200, { ok: true, sid: s.id, reply: GREETING, audio: await greeting(), stt: speech.sttOn });
}

// POST /api/turn?sid=…  body: recorded audio (audio/webm, audio/mp4…) or JSON {text} for typed testing.
async function handleTurn(req, res) {
  if (!rateOk(clientIp(req), "t", 30, 60000)) return json(res, 429, { ok: false, error: "rate" });
  const sid = new URL(req.url, "http://x").searchParams.get("sid") || "";
  const s = sessions.get(sid);
  if (!s || s.ended) return json(res, 404, { ok: false, error: "session" });
  if (s.busy) return json(res, 409, { ok: false, error: "busy" });
  if (++s.turns > MAX_TURNS) { s.ended = true; return json(res, 200, { ok: true, reply: "ممنون از تماستون. لطفاً اگر کار دیگه‌ای دارید دوباره تماس بگیرید.", end: true }); }
  s.busy = true; s.seen = Date.now();
  try {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    let body;
    try { body = await readBody(req, MAX_AUDIO); } catch { return json(res, 413, { ok: false, error: "too large" }); }
    let transcript = "";
    const t = [Date.now()];   // per-step timings (seconds) are returned for tuning: hear, think, speak
    if (type === "application/json") {
      try { transcript = String(JSON.parse(body.toString("utf8")).text || "").trim().slice(0, 500); } catch {}
    } else {
      if (!speech.sttOn) return json(res, 503, { ok: false, error: "speech-to-text not configured" });
      if (body.length < 1500) transcript = "";   // too short to contain speech
      else transcript = await speech.transcribe(body, type, await refreshKnowledge());
    }
    t.push(Date.now());
    if (!transcript) return json(res, 200, { ok: true, transcript: "", reply: NOT_HEARD, audio: await cachedSpeak(NOT_HEARD) });
    if (type === "application/json") await refreshKnowledge();   // typed test turns get the same pronunciation rules
    const reply = await agent.respond(s, transcript);
    t.push(Date.now());
    const audioUrl = startTts(reply);   // synthesis runs in the background; the page streams it from this URL
    const timing = { hear: (t[1] - t[0]) / 1000, think: (t[2] - t[1]) / 1000 };
    // Asking for a national ID / mobile (not reading one back)? Callers pause between digit groups, so the page
    // waits for a longer silence before ending their turn.
    const slow = /کد ملی|شماره|موبایل/.test(reply) && !/درسته|صحیحه/.test(reply);
    json(res, 200, { ok: true, transcript, reply, audioUrl, end: s.ended, booked: s.booked, timing, slow });
  } catch (e) {
    console.error("turn failed:", e.message);
    json(res, 200, { ok: true, transcript: "", reply: TECH_ERROR, audio: await cachedSpeak(TECH_ERROR), error: true });
  } finally { s.busy = false; }
}

createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  try {
    if (req.method === "POST" && path === "/api/start") return await handleStart(req, res);
    if (req.method === "POST" && path === "/api/turn") return await handleTurn(req, res);
    if (req.method === "POST" && path === "/api/end") {
      const s = sessions.get(new URL(req.url, "http://x").searchParams.get("sid") || "");
      if (s) sessions.delete(s.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path.startsWith("/api/tts/")) return await handleTtsStream(req, res, path.slice(9));
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "permissions-policy": "microphone=(self)" });
      return res.end(await readFile(join(ROOT, "public", "index.html")));
    }
    res.writeHead(404); res.end("404");
  } catch (e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end("500"); } }
}).listen(PORT, () => {
  console.log(`Voice agent at http://localhost:${PORT}`);
  console.log(`Brain:  ${agent.describe()}`);
  console.log(`Speech: ${speech.describe()}`);
  console.log(`Bookings via ${booking.base}/api/book`);
  console.log(ACCESS_CODE ? "Access: private link only (ACCESS_CODE set)" : "Access: public");
});
