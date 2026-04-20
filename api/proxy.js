// api/proxy.js — Vercel Serverless Proxy (Hardened + Diagnostic)
// Reads API_BASE_URL server-side. Forwards Authorization header for JWT auth.
// The backend URL is never exposed to the browser.

// ── Config ──
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 100;
const FETCH_TIMEOUT = 30000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

// ── In-memory rate limiting (use Redis in production) ──
const requestCounts = new Map();

function checkRateLimit(clientId) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  for (const [key, timestamp] of requestCounts.entries()) {
    if (timestamp < windowStart) requestCounts.delete(key);
  }

  const count = Array.from(requestCounts.values()).filter(t => t > windowStart && requestCounts.get(clientId) === t).length;
  if (count >= MAX_REQUESTS_PER_WINDOW) return false;

  requestCounts.set(clientId, now);
  return true;
}

// ── Collect raw body from stream (Vercel doesn't always parse it) ──
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Sleep helper ──
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main handler ──
export default async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera()');

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  // Rate limiting
  const clientId = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(clientId)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Origin validation
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // ── CRITICAL: Validate API_BASE_URL ──
  const apiBase = process.env.API_BASE_URL;

  if (!apiBase) {
    console.error('[Proxy] FATAL: API_BASE_URL environment variable is not set');
    return res.status(500).json({
      error: 'Server configuration error',
      detail: 'API_BASE_URL is not configured in Vercel environment variables',
      fix: 'Go to Vercel Dashboard > Settings > Environment Variables and add API_BASE_URL pointing to your ALB (e.g., http://employee-dir-alb-xxx.elb.amazonaws.com)'
    });
  }

  // Warn if port 8080 is still being used (common misconfiguration)
  if (apiBase.includes(':8080')) {
    console.error('[Proxy] WARNING: API_BASE_URL contains :8080 which commonly causes timeouts. If your ALB only listens on port 80, remove the port.');
  }

  // ── Extract path from query ──
  let path = '';
  if (req.query?.path) {
    path = req.query.path;
  } else {
    const match = req.url.match(/[?&]path=([^&]+)/);
    if (match) path = decodeURIComponent(match[1]);
  }

  if (!path) {
    return res.status(400).json({ error: 'Bad request: path parameter is required' });
  }

  // Path traversal prevention
  if (path.includes('..') || path.includes('//')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!path.startsWith('/')) path = '/' + path;

  // ── Build target URL ──
  let targetUrl;
  try {
    const baseUrl = new URL(apiBase.replace(/\/$/, ''));
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const qsFiltered = qs.replace(/[?&]path=[^&]*/g, '').replace(/^&/, '?');
    targetUrl = new URL(path + qsFiltered, baseUrl);

    if (targetUrl.origin !== baseUrl.origin) {
      throw new Error('URL origin mismatch');
    }
  } catch (urlErr) {
    console.error('[Proxy] URL construction error:', urlErr.message);
    return res.status(400).json({ error: 'Invalid URL construction', detail: urlErr.message });
  }

  console.log(`[Proxy] ${req.method} ${path} → ${targetUrl.toString()}`);

  // ── Collect body explicitly (robust for Vercel) ──
  let bodyBuffer = Buffer.alloc(0);
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    try {
      bodyBuffer = await collectBody(req);
      if (bodyBuffer.length > 0) {
        console.log(`[Proxy] Body collected: ${bodyBuffer.length} bytes`);
      }
    } catch (bodyErr) {
      console.error('[Proxy] Body read error:', bodyErr.message);
    }
  }

  // ── Build headers ──
  const headers = {
    'Accept': 'application/json',
    'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    'X-Real-IP': req.headers['x-real-ip'] || req.socket?.remoteAddress || ''
  };

  // Forward content-type if present
  if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }

  // Forward JWT Authorization header
  if (req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(400).json({ error: 'Invalid Authorization header format' });
    }
    headers['Authorization'] = authHeader;
  }

  // ── Fetch with retry logic ──
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[Proxy] Retry attempt ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      const fetchOptions = {
        method: req.method,
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      };

      // Only attach body if we have one
      if (bodyBuffer.length > 0) {
        fetchOptions.body = bodyBuffer;
      }

      const apiRes = await fetch(targetUrl.toString(), fetchOptions);

      // Response size limit
      const contentLength = apiRes.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
        return res.status(502).json({ error: 'Response too large (>10MB)' });
      }

      const contentType = apiRes.headers.get('content-type') || '';
      const responseText = await apiRes.text();

      // Forward non-JSON responses as transparent proxy
      if (!contentType.includes('application/json')) {
        console.warn(`[Proxy] Non-JSON response (${apiRes.status}): ${contentType}, length: ${responseText.length}`);
        // Forward the response as-is instead of erroring
        res.status(apiRes.status);
        if (contentType) res.setHeader('Content-Type', contentType);
        return res.send(responseText);
      }

      // Parse and return JSON
      try {
        const jsonData = JSON.parse(responseText);
        return res.status(apiRes.status).json(jsonData);
      } catch (parseErr) {
        console.error('[Proxy] JSON parse error:', parseErr.message, '| Raw:', responseText.slice(0, 500));
        return res.status(502).json({
          error: 'Invalid JSON response from backend',
          detail: responseText.slice(0, 200)
        });
      }

    } catch (err) {
      lastError = err;
      console.error(`[Proxy] Fetch attempt ${attempt + 1} failed:`, err.name, '-', err.message);

      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        // Retryable error - continue to next attempt
        continue;
      }

      // Non-retryable errors: break immediately
      if (err.code === 'ECONNREFUSED') {
        return res.status(502).json({
          error: 'Connection refused — backend rejected the connection',
          detail: `Cannot connect to ${targetUrl.origin}. Check that the ALB security group allows inbound traffic from Vercel IPs, and the target port is correct.`,
          target: targetUrl.origin,
          code: err.code
        });
      }

      if (err.code === 'ENOTFOUND') {
        return res.status(502).json({
          error: 'DNS lookup failed — backend hostname not found',
          detail: `Cannot resolve ${targetUrl.hostname}. Check the API_BASE_URL environment variable.`,
          hostname: targetUrl.hostname,
          code: err.code
        });
      }

      if (err.code === 'ETIMEDOUT' || err.message?.includes('timed out')) {
        continue; // Retryable
      }

      // Unknown error on last attempt
      if (attempt === MAX_RETRIES) break;
    }
  }

  // ── All retries exhausted ──
  console.error('[Proxy] All retry attempts exhausted. Last error:', lastError);

  const isTimeout = lastError?.name === 'TimeoutError' ||
                    lastError?.message?.includes('timed out') ||
                    lastError?.message?.includes('timeout');

  return res.status(isTimeout ? 504 : 502).json({
    error: isTimeout ? 'Gateway timeout — backend did not respond in time' : 'Failed to reach API backend',
    detail: process.env.NODE_ENV === 'development' ? lastError?.message : undefined,
    troubleshooting: [
      `Current API_BASE_URL: ${apiBase}`,
      `Attempted target: ${targetUrl?.toString()}`,
      isTimeout ? 'The backend connection timed out. Common causes:' : 'The backend is unreachable. Common causes:',
      isTimeout ? '1. API_BASE_URL uses wrong port (e.g., :8080 instead of :80)' : '1. API_BASE_URL is incorrect or uses wrong port',
      '2. ALB security group blocks inbound from Vercel IP ranges',
      '3. Backend target group has no healthy targets',
      '4. VPC/network ACL blocking the connection',
      'Fix: Update API_BASE_URL in Vercel Dashboard > Settings > Environment Variables'
    ]
  });
}
