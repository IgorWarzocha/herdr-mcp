import OAuth2Server from '@node-oauth/oauth2-server';
import { isAbsolute } from 'node:path';
import { buildOAuthProtectedResourceMetadata, verifyBearerToken } from '@modelcontextprotocol/server';
import { createOAuthModel } from './oauth-store.mjs';
import { createApprovals } from './oauth-approval.mjs';

const json = (res, status, value, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(value));
const invalid = () => Object.assign(new Error('Invalid OAuth request'), { status: 400, error: 'invalid_request' });

function parameters(params) {
  const result = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw invalid();
    result[key] = value;
  }
  return result;
}

async function body(req, format) {
  if (req.headers['content-type']?.split(';')[0].trim() !== format) throw Object.assign(invalid(), { status: 415 });
  const chunks = []; let size = 0;
  const timer = setTimeout(() => req.destroy(), 10000);
  try {
    for await (const chunk of req) {
      if ((size += chunk.length) > 16384) throw Object.assign(invalid(), { status: 413 });
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return format === 'application/json' ? JSON.parse(text) : parameters(new URLSearchParams(text)); }
    catch { throw invalid(); }
  } finally { clearTimeout(timer); }
}

export function oauthConfig({ resource, stateFile, clientId = 'herdr-chatgpt', redirectUris }) {
  const url = new URL(resource);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || resource !== url.href.replace(/\/$/, '') || !url.pathname ||
      !stateFile || !isAbsolute(stateFile) || !/^[a-zA-Z0-9_-]{1,64}$/.test(clientId) || !Array.isArray(redirectUris) || !redirectUris.length) {
    throw new Error('OAuth needs a canonical HTTPS public resource URL, private state file, client ID and exact callback URLs.');
  }
  for (const callback of redirectUris) {
    const uri = new URL(callback);
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash || uri.search) throw new Error('OAuth callbacks must be exact HTTPS URLs without credentials, query or fragment.');
  }
  return { resource, stateFile, clientId, redirectUris };
}

export async function createOAuth(options) {
  const cfg = oauthConfig(options);
  const { resource, clientId, redirectUris } = cfg;
  const store = await createOAuthModel(cfg);
  const server = new OAuth2Server({ model: store.model, requirePKCE: true, enablePlainPKCE: false,
    authorizationCodeLifetime: 300, accessTokenLifetime: 3600, refreshTokenLifetime: 30 * 86400,
    alwaysIssueNewRefreshToken: true, requireClientAuthentication: { authorization_code: false, refresh_token: false } });
  const approvals = createApprovals(cfg);
  const metadataUrl = `${resource}/oauth/resource`;
  const metadata = {
    issuer: resource, authorization_endpoint: `${resource}/oauth/authorize`, token_endpoint: `${resource}/oauth/token`,
    revocation_endpoint: `${resource}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'], authorization_response_iss_parameter_supported: true,
  };
  const protectedResource = buildOAuthProtectedResourceMetadata({ resourceServerUrl: new URL(resource),
    oauthMetadata: metadata, scopesSupported: ['mcp'], resourceName: 'Herdr' });
  const answer = (res, response) => {
    if (response.headers.location) {
      const location = new URL(response.headers.location);
      location.searchParams.set('iss', resource);
      response.headers.location = location.href;
    }
    res.writeHead(response.status, response.headers).end(response.headers.location ? '' : JSON.stringify(response.body));
  };
  return {
    challenge: `Bearer resource_metadata="${metadataUrl}", scope="mcp"`,
    matches(rawUrl) {
      try { return new URL(rawUrl, 'http://localhost').pathname.startsWith('/mcp/oauth/'); }
      catch { return false; }
    },
    async authenticate(authorization) {
      try { return await verifyBearerToken(authorization, { verifier: store.verifier, expectedResource: new URL(resource), requiredScopes: ['mcp'], resourceMetadataUrl: metadataUrl }); }
      catch { return; }
    },
    async handle(req, res, admin) {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/mcp/oauth/')) return false;
      try {
        if (url.pathname === '/mcp/oauth/resource' || url.pathname === '/mcp/oauth/metadata') {
          if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return true; }
          res.setHeader('Access-Control-Allow-Origin', '*');
          json(res, 200, url.pathname.endsWith('/resource') ? protectedResource : metadata); return true;
        }
        if (url.pathname === '/mcp/oauth/authorize') {
          if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return true; }
          if (req.url.length > 8192) throw invalid();
          const query = parameters(url.searchParams);
          if (!query.request) approvals.begin(query, req, res);
          else {
            const approved = approvals.browser(query.request, req, res);
            if (approved) {
              const owner = store.owner();
              const response = new OAuth2Server.Response();
              try { await server.authorize(new OAuth2Server.Request({ headers: req.headers, method: 'GET', query: approved }), response,
                { authenticateHandler: { handle: () => owner } }); }
              catch (error) { if (!response.headers.location) throw error; }
              answer(res, response);
            }
          }
          return true;
        }
        if (['/mcp/oauth/approve', '/mcp/oauth/revoke-all'].includes(url.pathname)) {
          if (!admin || req.headers.origin) { json(res, 401, { error: 'access_denied' }); return true; }
          if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return true; }
          const input = await body(req, 'application/json');
          if (url.pathname.endsWith('/revoke-all')) { approvals.clear(); json(res, 200, { revoked: await store.revokeAll() }); }
          else {
            const approved = typeof input?.request_id === 'string' && approvals.approve(input.request_id);
            json(res, approved ? 200 : 404, approved || { error: 'invalid_request' });
          }
          return true;
        }
        if (['/mcp/oauth/token', '/mcp/oauth/revoke'].includes(url.pathname)) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }).end(); return true;
          }
          if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, OPTIONS' }).end(); return true; }
          const input = await body(req, 'application/x-www-form-urlencoded');
          if (Object.hasOwn(input, 'client_secret') || req.headers.authorization) throw invalid();
          if (url.pathname.endsWith('/revoke')) {
            if (input.client_id !== clientId || !input.token) throw invalid();
            await store.revoke(input.token); json(res, 200, {}); return true;
          }
          if (input.resource !== resource) { json(res, 400, { error: 'invalid_target' }); return true; }
          const response = new OAuth2Server.Response();
          await server.token(new OAuth2Server.Request({ headers: req.headers, method: 'POST', query: {}, body: input }), response);
          answer(res, response); return true;
        }
        res.writeHead(404).end();
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          const known = ['invalid_request', 'invalid_client', 'invalid_grant', 'invalid_scope', 'unsupported_grant_type', 'access_denied'];
          const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
          json(res, status,
            { error: known.includes(error.error || error.name) ? error.error || error.name : 'server_error' });
        } else res.destroy();
      }
      return true;
    },
    close() { approvals.clear(); },
  };
}
