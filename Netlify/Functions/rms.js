/**
 * RMS API Proxy — Sunset Shores
 * ─────────────────────────────────────────────────────────────────────────────
 * Credentials are stored as Netlify Environment Variables — never in this file.
 *
 * In Netlify Dashboard go to:
 * Site Settings → Environment Variables → Add variable:
 *   RMS_USER = sunset_frangie_1736
 *   RMS_PASS = b784hjkp9w5T
 *
 * RATE LIMITING:
 *   Each visitor (by IP) is limited to 20 requests per minute.
 *   This protects against abuse, accidental loops, and bots hammering
 *   the search/booking endpoints. Netlify Functions are stateless between
 *   cold starts, so this is a best-effort in-memory limiter — for stricter
 *   protection at scale, pair this with Netlify Rate Limiting (Edge) or
 *   a service like Upstash Redis.
 *
 * PLATFORM SWITCHING GUIDE:
 *   Netlify:           keep at netlify/functions/rms.js         (current)
 *   Vercel:            move to api/rms.js, use process.env as-is
 *   Cloudflare Worker: paste core logic into Worker, use env.RMS_USER
 *   Node/Express:      wrap in app.get('/api/rms', ...), use process.env
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

// ── CREDENTIALS — loaded from Netlify environment variables, never hardcoded ─
const RMS_USER = process.env.RMS_USER;
const RMS_PASS = process.env.RMS_PASS;
const RMS_BASE = 'https://portal7.resortplanet.com/rms-live/xml';

// ── RATE LIMITING ────────────────────────────────────────────────────────────
// In-memory store: { ip: [timestamp, timestamp, ...] }
// Resets whenever the function "cold starts" (after idle time) — good enough
// for a small site, not bulletproof against distributed abuse.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;   // 1 minute window
const RATE_LIMIT_MAX_REQ   = 20;          // max requests per window per IP
const requestLog = {};

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog[ip] || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog[ip] = timestamps;

  // Clean up old IPs occasionally so memory doesn't grow forever
  if (Math.random() < 0.05) {
    Object.keys(requestLog).forEach(key => {
      requestLog[key] = requestLog[key].filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (requestLog[key].length === 0) delete requestLog[key];
    });
  }

  return timestamps.length > RATE_LIMIT_MAX_REQ;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    if (!RMS_USER || !RMS_PASS) {
      return reject(new Error('RMS credentials not configured. Please set RMS_USER and RMS_PASS environment variables in Netlify.'));
    }

    const AUTH_HDR = 'Basic ' + Buffer.from(RMS_USER + ':' + RMS_PASS).toString('base64');
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'GET',
      headers: {
        'Authorization': AUTH_HDR,
        'Accept':        'application/xml, text/xml, */*',
        'User-Agent':    'SunsetShores/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── RATE LIMIT CHECK ────────────────────────────────────────────────────
  const ip = event.headers['x-nf-client-connection-ip']
          || event.headers['client-ip']
          || event.headers['x-forwarded-for']
          || 'unknown';

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Retry-After': '60'
      },
      body: `<error><message>Too many requests. Please wait a moment and try again.</message></error>`
    };
  }

  const params  = event.queryStringParameters || {};
  const rmsPath = params.path;

  if (!rmsPath) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing path parameter' }) };
  }

  const fullUrl = RMS_BASE + rmsPath;

  if (!fullUrl.startsWith('https://portal7.resortplanet.com/rms-live/')) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const response = await httpsGet(fullUrl);
    return {
      statusCode: response.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type':                'text/xml; charset=utf-8',
        'Cache-Control':               'no-store'
      },
      body: response.body
    };
  } catch(err) {
    console.error('RMS proxy error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: `<error><message>${err.message}</message></error>`
    };
  }
};
