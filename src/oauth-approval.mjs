import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cookieName = 'herdr_oauth_request';
const lifetime = 5 * 60 * 1000;

// A browser can request access, but only an operator holding the existing
// bridge credential can approve it. No bridge secret enters the browser.
export function createApprovals({ resource, clientId, redirectUris }) {
  const pending = new Map();
  const authorizeUrl = `${resource}/oauth/authorize`;
  const cookiePath = new URL(authorizeUrl).pathname;
  const cookie = (value, age) => `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${age}${resource.startsWith('https:') ? '; Secure' : ''}`;
  const prune = () => { for (const [id, entry] of pending) if (entry.expires <= Date.now()) pending.delete(id); };

  return {
    begin(query, req, res) {
      prune();
      if (query.client_id !== clientId || !redirectUris.includes(query.redirect_uri) || query.response_type !== 'code' ||
          query.resource !== resource || query.code_challenge_method !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? '') || !query.state || query.state.length > 2048) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_request' })); return;
      }
      if (query.scope && query.scope !== 'mcp') {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_scope' })); return;
      }
      if (pending.size >= 64) { res.writeHead(503).end('Too many pending approvals. Try again later.'); return; }
      const id = randomBytes(24).toString('hex'), browser = randomBytes(32).toString('hex');
      pending.set(id, { query, browser: digest(browser), approved: false, expires: Date.now() + lifetime });
      res.writeHead(303, { Location: `${authorizeUrl}?request=${id}`, 'Set-Cookie': cookie(browser, 300) }).end();
    },
    browser(id, req, res) {
      prune();
      const entry = pending.get(id);
      const browser = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!entry || !browser || !timingSafeEqual(entry.browser, digest(browser))) { res.writeHead(404).end('This approval is missing or expired. Start the connection again.'); return; }
      if (entry.approved) {
        pending.delete(id);
        res.setHeader('Set-Cookie', cookie('', 0));
        return entry.query;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" })
        .end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Approve Herdr access</title><main><h1>Approve Herdr access</h1><p>This connection can launch programs and control agents on this bridge's configured machines.</p><p>Client: <strong>${escape(clientId)}</strong></p><p>Callback: <code>${escape(entry.query.redirect_uri)}</code></p><p>Run this in the bridge checkout on its host, with the same environment as its service:</p><pre>npm run oauth -- approve ${escape(id)}</pre><p>This page continues after approval. The request expires in five minutes.</p></main></html>`);
    },
    approve(id) {
      prune();
      const entry = pending.get(id);
      if (!entry) return;
      entry.approved = true;
      return { approved: true, client_id: clientId, redirect_uri: entry.query.redirect_uri, resource };
    },
    clear() { pending.clear(); },
  };
}
