// app.ts — the entry's HTTP server: Git smart HTTP, REST v3, GraphQL v4 and MCP in one
// process, over one in-memory forge. main.ts owns the lifecycle (listen(0), register,
// poll done); this file owns the routes. Standard library only.
//
// Auth: the env passes MAKEFUN_SHOP_TOKEN. When it is set, a request needs exactly
// `Bearer <that token>`; when it is unset (local development), any non-empty Bearer
// token is accepted as the viewer. /healthz needs no auth.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest, type Query } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const forge = new Forge();

function token(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  const expected = token();
  return expected === '' ? true : presented === expected;
}

function requestId(): string {
  return forge.nextRequestId();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendJsonText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a request URL into its path and query map without allocating a URL object (hot path). */
function parseUrl(req: IncomingMessage): { path: string; query: Query } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const query: Query = {};
  if (q >= 0) {
    for (const pair of raw.slice(q + 1).split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      query[decodeQueryComponent(key)] = decodeQueryComponent(value);
    }
  }
  return { path, query };
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return host !== undefined ? `http://${host}` : 'http://entry';
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The JSON body of a request, or null when the body is empty. Throws on malformed JSON. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  return JSON.parse(body.toString('utf8'));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = parseUrl(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const segments = path.split('/').filter((segment) => segment !== '');

  // Git smart HTTP: /<owner>/<repo>.git/info/refs | git-upload-pack | git-receive-pack
  if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
    const owner = decode(segments[0]!);
    const repoName = decode(segments[1].slice(0, -'.git'.length));
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (method === 'GET' && segments.length >= 4 && segments[2] === 'info' && segments[3] === 'refs') {
      const service = query.service === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
      const result = handleInfoRefs(forge, owner, repoName, service, isV2);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && segments[2] === 'git-upload-pack') {
      const result = handleUploadPack(forge, owner, repoName, body, isV2);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && segments[2] === 'git-receive-pack') {
      const result = handleReceivePack(forge, owner, repoName, body);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4: POST /api/graphql (a single operation, or a batch array).
  if (method === 'POST' && path === '/api/graphql') {
    let parsed: unknown;
    try {
      parsed = parseJsonBody(body);
    } catch {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return;
    }
    if (parsed === null) {
      sendJson(res, 400, { message: 'Empty GraphQL request' });
      return;
    }
    const runOne = (operation: unknown): Record<string, unknown> => {
      const record = (operation ?? {}) as Record<string, unknown>;
      const queryText = typeof record.query === 'string' ? record.query : '';
      let variables: Record<string, unknown> = {};
      if (typeof record.variables === 'string') {
        try {
          variables = (JSON.parse(record.variables) as Record<string, unknown>) ?? {};
        } catch {
          variables = {};
        }
      } else if (typeof record.variables === 'object' && record.variables !== null) {
        variables = record.variables as Record<string, unknown>;
      }
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      return executeGraphQL(forge, queryText, variables, operationName) as Record<string, unknown>;
    };
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map(runOne));
      return;
    }
    sendJson(res, 200, runOne(parsed));
    return;
  }

  // MCP: POST /mcp.
  if (method === 'POST' && path === '/mcp') {
    const result = handleMcp(forge, body.toString('utf8'));
    if (result.body === null) {
      sendEmpty(res, result.status);
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // REST v3: /api/v3/...
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3'.length);
    let parsed: unknown = null;
    if (body.length > 0) {
      try {
        parsed = parseJsonBody(body);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const result = handleRest({ forge, baseUrl: baseUrlOf(req) }, method, restPath, query, parsed);
    if (result.status === 204 || (result.body === null && result.bodyText === undefined)) {
      sendEmpty(res, result.status);
      return;
    }
    if (result.bodyText !== undefined) {
      sendJsonText(res, result.status, result.bodyText, result.headers ?? {});
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      // Never let one request kill the server: the suite checks that it stays healthy
      // through 404s, refusals and malformed requests.
      process.stderr.write(`[app] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    });
  });
}
