# Voice agent: Persian voice receptionist for a clinic (Ainoor)

A web "call" page: a parent taps the button and talks in **Persian**; the agent offers free times, collects the
child's name, national ID and mobile **by voice** (with natural grouped read-back), and books through the clinic
site's API. Voice bookings get the same SMS.ir texts and Telegram/Bale ✅/❌ as web bookings (tagged `📞 Voice agent`).
First instance: `https://voice.ainoor.io` for Dr. Hashemi (clinic site `https://demo.ainoor.io`).

> Agency playbook for setting this up for a new clinic: skill **`clinic-voice-agent`** in the `ainoor` repo
> (`.claude/skills/clinic-voice-agent/SKILL.md`).

```
browser mic ─(one utterance per POST /api/turn)─▶ voice agent (this service, Node 22, zero deps)
                                                   ├─ STT   ElevenLabs Scribe v2, language fas, key terms
                                                   ├─ numbers.mjs  spoken Persian numbers → exact digits + read-back
                                                   ├─ brain Claude Sonnet 5.5 + tools: get_open_slots, book_appointment, end_call
                                                   └─ TTS   ElevenLabs Eleven v4 turbo, streamed via GET /api/tts/<id>
                                                        │ server-to-server
                                                        ▼
                              clinic site  GET /api/slots · POST /api/book (strict) · GET /api/knowledge
```

The browser only ever talks to this service — ElevenLabs/Anthropic block Iranian IPs, so every AI call is server-side.

## Files
| File | What |
|---|---|
| `server.mjs` | HTTP: `POST /api/start` (session + cached greeting), `POST /api/turn?sid=` (audio or JSON `{text}`), `GET /api/tts/<id>` (streamed reply audio), `POST /api/end`, `/healthz`; sessions, rate limits, `ACCESS_CODE` gate, pronunciation fixes + STT key terms |
| `agent.mjs` | Claude tool loop, system prompt (`GREETING`, `CLINIC_INFO` with `{{HOURS}}/{{CONTACT}}/{{FEES}}` filled from the site), booking client (`/api/slots`, `/api/book`, `/api/knowledge` cached 60 s) |
| `numbers.mjs` | Persian number words → digits («و» joins inside a group), checksum / mobile checks, grouped read-back |
| `speech.mjs` | ElevenLabs STT/TTS adapter (swap in an Iranian provider here only) |
| `public/index.html` | the call page (RTL, voice-activity detection, streamed playback, typed fallback with `?debug=1`) |

## What comes from the clinic site (changes made by staff in the bot appear on the next call)
Working hours, clinic phone/WhatsApp, visit prices, the announcement, staff-taught facts and `/say` pronunciations
(`GET /api/knowledge`), and free slots (`GET /api/slots`). Only the doctor's identity, address, services and the
greeting are written in this repo (`agent.mjs`, `server.mjs` `BASE_TERMS`, `public/index.html`).

## Run locally
1. Clinic site: `cd ../website && node server.mjs` (mock mode without bot/SMS keys; use a scratch `DATA_DIR`).
2. `cp .env.example .env`, fill `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`; set `BOOKING_API_BASE=http://localhost:3000`.
3. `node server.mjs` → http://localhost:3100 (mic works on localhost; production needs HTTPS). `?debug=1` = typed chat.
Test Persian text with a Node script, not Git-Bash `curl` (it sends `???`).

## Env vars
| Var | Default / notes |
|---|---|
| `ANTHROPIC_API_KEY` | required for the brain |
| `VOICE_MODEL` | `claude-sonnet-5-5` (tested: ~2 s/reply; Opus 5.5 2–12 s; Haiku 4.5 weaker Persian) |
| `VOICE_EFFORT` / `VOICE_THINKING` | `low` / unset |
| `ELEVENLABS_API_KEY` | key needs **Speech to Text + Text to Speech + Voices (read)** |
| `ELEVENLABS_VOICE_ID` | library voices need a **paid** plan (free = premade voices only, non-commercial). Persian picks: Roya `ndcUYGFbbd96WXiZVVaQ`, Niloofar, Setareh |
| `TTS_MODEL` | `eleven_v4_turbo` (v3 also fine; Flash/Turbo v2.5 have no Persian) |
| `STT_MODEL` / `STT_LANGUAGE` | `scribe_v2` / `fas` |
| `BOOKING_API_BASE` | clinic site URL (bookings are real) |
| `ACCESS_CODE` | optional private-link gate: calls only start from `/?k=<code>` |
| `PORT` | `3100` |

## Deploy (Coolify, Hostinger VPS)
Dockerfile build pack, port **3100**, healthcheck `/healthz`, domain with HTTPS (`voice.<clinic domain>` — the mic
needs HTTPS). Use the purple **Deploy** for new commits ("Restart" keeps old code).

## Behaviour & tuning notes
- **Turn-based**: end of speech = **1.0 s** silence (2 s right after asking for a number); 0.8 s cut callers off.
  Typical reply ≈ 3–5 s (hear ~0.5 s, think ~1.5–4 s, first audio ~0.15 s after the text thanks to streaming).
  Phase 2 = realtime WebSocket with barge-in.
- **Numbers**: never let the model convert long numbers; `numbers.mjs` gives it exact digits + the read-back text.
- **Goodbye**: `end_call` ends the turn without another model call.
- **Safety**: ≤3 bookings per call (siblings), 40 turns, per-IP limits; `book_appointment` needs explicit
  confirmation + valid national-ID checksum; the site returns 409 for unavailable slots; no medical advice (115 for emergencies).
- **Privacy**: transcripts in memory only (20 min TTL); logs carry tool names only. Audio/text pass through ElevenLabs and Anthropic.
- **Phone line (later, Iran)**: Iranian AI-phone provider calling our booking API, or Iranian SIP trunk → Asterisk AudioSocket → this brain.
