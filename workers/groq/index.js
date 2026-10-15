const ALLOWED_ORIGINS = new Set([
  'https://alvarorequenac.github.io',
]);
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/transcribe') {
      return json({ error: 'Not found' }, 404, origin);
    }
    if (!env.GROQ_API_KEY) {
      return json({ error: 'Transcription service is not configured.' }, 503, origin);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.TRANSCRIPTION_LIMITER.limit({ key: ip });
    if (!success) {
      return json({ error: 'Rate limit exceeded. Wait a minute and try again.' }, 429, origin, { 'Retry-After': '60' });
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > MAX_AUDIO_BYTES + 1024 * 1024) {
      return json({ error: 'Audio file is too large.' }, 413, origin);
    }

    let input;
    try {
      input = await request.formData();
    } catch {
      return json({ error: 'Expected multipart audio form data.' }, 400, origin);
    }
    const file = input.get('file');
    if (!(file instanceof File) || file.size === 0) return json({ error: 'Audio file is missing or empty.' }, 400, origin);
    if (file.size > MAX_AUDIO_BYTES) return json({ error: 'Audio file is too large.' }, 413, origin);

    const form = new FormData();
    form.append('file', file, 'audio.wav');
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('prompt', String(input.get('prompt') || '').slice(0, 520));

    let upstream;
    try {
      upstream = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: form,
      });
    } catch {
      return json({ error: 'Could not reach the transcription provider.' }, 502, origin);
    }

    const headers = {
      ...corsHeaders(origin),
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    const retryAfter = upstream.headers.get('Retry-After');
    if (retryAfter) headers['Retry-After'] = retryAfter;
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
