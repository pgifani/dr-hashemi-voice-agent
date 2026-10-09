// Speech adapters: Persian speech-to-text and text-to-speech.
// Kept behind two small functions so an Iranian provider (Nevisa, iotype, Avasho…) can replace
// ElevenLabs later without touching the dialogue code.
//
// ElevenLabs notes (checked 2026-10-07):
//   - STT: Scribe v2 rates Persian at 5–10% WER.
//   - TTS: Flash/Turbo v2.5 do NOT support Persian; Eleven v3 does (and v4 lists 90+ languages).
//   - ElevenLabs blocks Iranian IPs, so these calls must come from the server, never the browser.

const EL_BASE = "https://api.elevenlabs.io/v1";

export function createSpeech(env) {
  const key = (env.ELEVENLABS_API_KEY || "").trim();
  const voiceId = (env.ELEVENLABS_VOICE_ID || "").trim();
  const sttModel = (env.STT_MODEL || "scribe_v2").trim();
  const sttLang = (env.STT_LANGUAGE || "fas").trim();
  const ttsModel = (env.TTS_MODEL || "eleven_v4_turbo").trim();
  const ttsFormat = (env.TTS_FORMAT || "mp3_44100_64").trim();

  // Returns the transcript text ("" when nothing intelligible was said).
  // keyterms: words the recognizer should expect (clinic names, places, services).
  async function transcribe(audio, mime, keyterms = []) {
    if (!key) throw new Error("ELEVENLABS_API_KEY not set");
    const form = new FormData();
    form.append("model_id", sttModel);
    if (sttLang) form.append("language_code", sttLang);
    form.append("tag_audio_events", "false");
    for (const k of keyterms.slice(0, 100)) form.append("keyterms", k);   // one field per term
    const ext = /mp4|aac|m4a/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm";
    form.append("file", new Blob([audio], { type: mime || "audio/webm" }), `turn.${ext}`);
    const r = await fetch(`${EL_BASE}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: form });
    if (!r.ok) throw new Error(`STT ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return String(data.text || "").trim();
  }

  // Returns MP3 bytes, or null when TTS isn't configured (the page then shows the text only).
  async function synthesize(text) {
    if (!key || !voiceId || !text) return null;
    const r = await fetch(`${EL_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ttsFormat}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: ttsModel }),
    });
    if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  // Streams MP3 chunks as ElevenLabs produces them, so playback can start before the whole reply is synthesized.
  async function* streamSynthesize(text) {
    if (!key || !voiceId || !text) return;
    const r = await fetch(`${EL_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${ttsFormat}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: ttsModel }),
    });
    if (!r.ok) throw new Error(`TTS stream ${r.status}: ${(await r.text()).slice(0, 200)}`);
    for await (const chunk of r.body) yield Buffer.from(chunk);
  }

  return {
    transcribe, synthesize, streamSynthesize,
    sttOn: !!key,
    ttsOn: !!(key && voiceId),
    describe: () => key
      ? `ElevenLabs (STT ${sttModel}/${sttLang}${voiceId ? `, TTS ${ttsModel}` : ", TTS off: set ELEVENLABS_VOICE_ID"})`
      : "off (set ELEVENLABS_API_KEY; text mode only)",
  };
}
