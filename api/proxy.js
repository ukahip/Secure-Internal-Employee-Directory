// api/proxy.js — Vercel Serverless Proxy
// Reads API_BASE_URL server-side. Forwards Authorization header for JWT auth.
// The backend URL is never exposed to the browser.

export default async function handler(req, res) {
  const apiBase = process.env.API_BASE_URL;
  
  if (!apiBase) {
    console.error('API_BASE_URL not set in Vercel environment variables');
    return res.status(500).json({ 
      error: 'Server configuration error: API_BASE_URL not set',
      detail: 'The API_BASE_URL environment variable must be configured in Vercel project settings'
    });
  }

  // Extract path from query param set by vercel.json rewrite
  let path = '';
  if (req.query && req.query.path) {
    path = req.query.path;
  } else {
    const match = req.url.match(/[?&]path=([^&]+)/);
    if (match) path = decodeURIComponent(match[1]);
  }
  
  if (!path) {
    return res.status(400).json({ 
      error: 'Bad request: path parameter is required',
      detail: 'The path query parameter must be provided'
    });
  }
  
  if (!path.startsWith('/')) path = '/' + path;

  // Preserve any additional query string (e.g. ?name=search)
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const qsFiltered = qs.replace(/[?&]path=[^&]*/g, '').replace(/^&/, '?');
  const targetUrl = apiBase.replace(/\/$/, '') + path + qsFiltered;

  console.log(`[Proxy] ${req.method} ${path} → ${targetUrl}`);

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Forward JWT Authorization header — required for protected routes
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    // Forward other important headers
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'];
    }

    const options = { 
      method: req.method, 
      headers 
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const apiRes = await fetch(targetUrl, options);
    const contentType = apiRes.headers.get('content-type') || '';
    const responseText = await apiRes.text();

    if (!contentType.includes('application/json')) {
      console.error(`[Proxy] Non-JSON response from backend: ${contentType}`);
      return res.status(502).json({
        error: 'Non-JSON response from backend',
        status: apiRes.status,
        preview: responseText.slice(0, 200),
        targetUrl
      });
    }

    // Parse and return the JSON response
    try {
      const jsonData = JSON.parse(responseText);
      return res.status(apiRes.status).json(jsonData);
    } catch (parseErr) {
      console.error('[Proxy] JSON parse error:', parseErr.message);
      return res.status(502).json({
        error: 'Invalid JSON response from backend',
        detail: parseErr.message,
        preview: responseText.slice(0, 200)
      });
    }

  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    return res.status(502).json({ 
      error: 'Failed to reach API backend', 
      detail: err.message,
      targetUrl,
      suggestion: 'Check that your EC2/ALB is running and accessible from Vercel'
    });
  }
}
