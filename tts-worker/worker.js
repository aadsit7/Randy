/**
 * TTS Relay Worker — proxies requests to ElevenLabs /v1/text-to-speech/{voiceId}/stream
 * and relays chunked audio/mpeg back to the browser.
 *
 * Environment secret required:
 *   ELEVENLABS_API_KEY — set via `npx wrangler secret put ELEVENLABS_API_KEY`
 */

const CORS_HEADERS = {
  // TODO: restrict to your GitHub Pages domain in production, e.g.:
  // "Access-Control-Allow-Origin": "https://aadsit7.github.io",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB"; // Adam

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname !== "/tts") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    try {
      let text, voiceId, modelId;

      if (request.method === "POST") {
        const body = await request.json();
        text = body.text;
        voiceId = body.voiceId;
        modelId = body.modelId;
      } else if (request.method === "GET") {
        text = url.searchParams.get("text");
        voiceId = url.searchParams.get("voiceId");
        modelId = url.searchParams.get("modelId");
      } else {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      if (!text) {
        return new Response(JSON.stringify({ error: "Missing 'text' parameter" }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      voiceId = voiceId || DEFAULT_VOICE;
      modelId = modelId || DEFAULT_MODEL;

      const elevenUrl = `${ELEVENLABS_BASE}/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`;

      const upstream = await fetch(elevenUrl, {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        return new Response(JSON.stringify({ error: errText }), {
          status: upstream.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  },
};
