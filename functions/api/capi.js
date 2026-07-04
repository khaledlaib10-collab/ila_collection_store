// ████████████████████████████████████████████████████████
// ILA Collection — Meta Conversions API (server-side)
// Cloudflare Pages Function
// Path: /functions/api/capi.js  →  endpoint: POST /api/capi
//
// Env vars needed (Cloudflare Pages → Settings → Environment variables):
//   META_ACCESS_TOKEN   = System User / long-lived access token
//   META_PIXEL_ID       = 868209606342878
//   META_TEST_EVENT_CODE (optional, only while testing in Events Manager)
// ████████████████████████████████████████████████████████

const GRAPH_VERSION = 'v21.0';

async function sha256Hex(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  const enc = new TextEncoder().encode(normalized);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(hashBuf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const {
      event_name,
      event_id,
      event_time,
      event_source_url,
      action_source = 'website',
      custom_data = {},
      user_data = {}
    } = body || {};

    if (!event_name) {
      return json({ error: 'event_name is required' }, 400);
    }

    const cookieHeader = request.headers.get('Cookie') || '';
    const fbp = user_data.fbp || getCookie(cookieHeader, '_fbp');
    const fbc = user_data.fbc || getCookie(cookieHeader, '_fbc');

    const clientIp =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For') ||
      undefined;
    const userAgent = request.headers.get('User-Agent') || undefined;

    // Hash PII fields per Meta requirements. Never send plaintext PII.
    const [em, ph, external_id] = await Promise.all([
      sha256Hex(user_data.em),
      sha256Hex(user_data.ph),
      sha256Hex(user_data.external_id)
    ]);

    const payloadUserData = {
      ...(em ? { em: [em] } : {}),
      ...(ph ? { ph: [ph] } : {}),
      ...(external_id ? { external_id } : {}),
      ...(fbp ? { fbp } : {}),
      ...(fbc ? { fbc } : {}),
      ...(clientIp ? { client_ip_address: clientIp } : {}),
      ...(userAgent ? { client_user_agent: userAgent } : {})
    };

    const eventPayload = {
      event_name,
      event_time: event_time || Math.floor(Date.now() / 1000),
      event_id, // MUST match the browser Pixel event_id for deduplication
      event_source_url,
      action_source,
      user_data: payloadUserData,
      custom_data
    };

    const pixelId = env.META_PIXEL_ID || '868209606342878';
    const accessToken = env.META_ACCESS_TOKEN;

    if (!accessToken) {
      return json({ error: 'META_ACCESS_TOKEN not configured' }, 500);
    }

    const fbUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events`;

    const fbBody = {
      data: [eventPayload],
      access_token: accessToken
    };
    if (env.META_TEST_EVENT_CODE) {
      fbBody.test_event_code = env.META_TEST_EVENT_CODE;
    }

    const fbRes = await fetch(fbUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fbBody)
    });

    const fbJson = await fbRes.json();

    return json({ ok: fbRes.ok, meta: fbJson }, fbRes.ok ? 200 : 502);
  } catch (err) {
    return json({ error: 'CAPI handler failed', detail: String(err) }, 500);
  }
}

// Reject non-POST methods explicitly (nice error instead of default 405 HTML)
export async function onRequestGet() {
  return json({ error: 'Use POST' }, 405);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
