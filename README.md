# Voice agent: Persian phone receptionist for Dr. Hashemi's clinic

Prototype, phase 1: a web "call" page. The caller talks in Persian, and the agent finds a free time, collects name, national ID and mobile **by voice** (with read-back), and books through the clinic website's existing API. A voice booking therefore gets the same SMS.ir texts and Telegram/Bale Confirm/Decline as a web booking. Staff messages are tagged `📞 Voice agent (Persian)`.

```
browser mic ─(one utterance per POST)─▶ voice-agent (this service, Node, zero deps)
                                         ├─ STT  ElevenLabs Scribe v2 (fa)
                                         ├─ brain Claude + tools: get_open_slots, book_appointment, end_call
                                         └─ TTS  ElevenLabs Eleven v3 (Persian)  ─▶ MP3 back to the browser
                                              │
                                              ▼ server-to-server
                              website/server.mjs  GET /api/slots · POST /api/book (strict)
```

The browser only ever talks to this service. ElevenLabs blocks Iranian IPs, so every AI call is made server-side.

## Run locally

1. Start the website backend: `cd ../website && node server.mjs` (port 3000). Without bot or SMS keys it runs in mock mode and prints messages instead of sending them.
2. `cp .env.example .env` and fill in `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. Pick a voice that sounds natural in Persian from the ElevenLabs Voice Library.
3. `node server.mjs`, then open http://localhost:3100 (microphone access works on localhost; production needs HTTPS).

- With no ElevenLabs key the page falls back to a typed chat, which is handy for testing the dialogue.
- `?debug=1` forces the typed chat even when speech is on.

## Deploy (Coolify on the Hostinger VPS)

- New resource from this folder's repo, **Dockerfile** build pack, port **3100**, healthcheck `/healthz`.
- Set the env vars from `.env.example` in Coolify. Set `BOOKING_API_BASE` to the clinic site's public URL, or its internal Coolify URL if both run on the same server.
- Give it a domain with HTTPS (e.g. `voice.<clinic domain>`), because browsers only allow the mic over HTTPS.
- To put it on the clinic site, link a "تماس صوتی" button to that URL. If you embed it with an iframe, add `allow="microphone"`.

## Notes

- **Turn-based on purpose.** Each turn takes about 2–4 s, and the agent can't be interrupted while it speaks. Phase 2 is a WebSocket stream with barge-in; phase 3 is a real phone line (an Iranian SIP trunk into Asterisk AudioSocket, or an Iranian AI-phone provider calling our tools).
- **Swappable speech.** STT and TTS live in `speech.mjs`, so an Iranian provider (Nevisa/iotype STT, Avasho TTS) can replace ElevenLabs there.
- **Privacy.** Transcripts stay in memory only (20-minute session TTL), and logs record tool names only, never patient data. Audio and text do pass through ElevenLabs and Anthropic.
- **Safeguards.**
  - Up to 3 bookings per call, 40 turns per call, and per-IP rate limits.
  - `book_appointment` requires the caller's explicit confirmation and a valid national-ID checksum.
  - The website rejects taken, blocked or out-of-hours slots with a 409.
- **Clinic facts.** These are duplicated in `agent.mjs` (`CLINIC_INFO`). Keep them in sync with `website/server.mjs`. Working hours come from the website via `/api/slots`.
