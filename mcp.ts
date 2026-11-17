// mcp.ts — MCP over POST /mcp: JSON-RPC 2.0 Streamable HTTP (plain JSON replies, no SSE).
// server/discover (2026-07-28 era) and the legacy initialize handshake, tools/list and
// tools/call. Standard library only; the tools delegate to the same forge store as REST.
import {
  Forge,
  VIEWER_LOGIN,
  issueJson,
  pullJson,
  repoJson,
} from './store.ts';

export interface McpResponse {
  status: number;
  body: unknown | null;
}

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25']);
const KNOWN_VERSIONS = new Set(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Readonly<Record<string, { type: string; description: string }>>;
    required: readonly string[];
  };
}

/** The tool list, built once and frozen: tools/list must be byte-identical across calls. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; defaults to the viewer.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'string', description: 'Labels to apply, as a JSON array string or an array.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'string', description: 'The issue number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'string', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
  Object.freeze({
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
]);

function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = pick(args, ...names);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function pickNumber(args: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = pick(args, ...names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Resolve owner/repo from the mapper's argument synonyms (or a full_name). */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = pickString(args, 'full_name', 'fullName');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  const owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'login');
  const repo = pickString(args, 'repo', 'repository', 'repo_name', 'repository_name');
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  return null;
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const MISSING_ARGS = -32602;
const METHOD_NOT_FOUND = -32601;

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = pickString(args, 'name', 'repo', 'repository');
      if (repoName === undefined) return toolError('create_repo requires "name"');
      const owner = pickString(args, 'owner', 'owner_login', 'org') ?? VIEWER_LOGIN;
      const description = pickString(args, 'description', 'body') ?? '';
      const isPrivate = pick(args, 'private', 'is_private') === true;
      const created = forge.createRepo(owner, repoName, isPrivate, description);
      if (created.error !== undefined) return toolError(created.error);
      return toolResult(repoJson(forge, created.repo!));
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('get_repo requires "owner" and "repo"');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      const title = pickString(args, 'title', 'name');
      if (target === null || title === undefined) return toolError('create_issue requires "owner", "repo" and "title"');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const bodyText = pickString(args, 'body', 'description', 'text') ?? '';
      const labelsRaw = pick(args, 'labels');
      let labels: string[] = [];
      if (Array.isArray(labelsRaw)) labels = labelsRaw.filter((label): label is string => typeof label === 'string');
      else if (typeof labelsRaw === 'string') {
        try {
          const parsed: unknown = JSON.parse(labelsRaw);
          if (Array.isArray(parsed)) labels = parsed.filter((label): label is string => typeof label === 'string');
        } catch {
          labels = [labelsRaw];
        }
      }
      const created = forge.createIssue(repo, title, bodyText, labels);
      if (created.error !== undefined) return toolError(created.error);
      return toolResult(issueJson(forge, repo, created.issue!));
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('list_issues requires "owner" and "repo"');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const state = pickString(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult({
        repository: `${target.owner}/${target.repo}`,
        owner: target.owner,
        repo: target.repo,
        issues: issues.map((issue) => issueJson(forge, repo, issue)),
      });
    }
    case 'get_issue': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, 'issue_number', 'number', 'issueNumber');
      if (target === null || number === undefined) return toolError('get_issue requires "owner", "repo" and "issue_number"');
      const repo = forge.getRepo(target.owner, target.repo);
      const issue = repo?.issues.get(number);
      if (repo === undefined || issue === undefined) return toolError('Not Found');
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      const title = pickString(args, 'title', 'name');
      const head = pickString(args, 'head', 'head_branch', 'source_branch', 'head_ref');
      const base = pickString(args, 'base', 'base_branch', 'target_branch', 'base_ref');
      if (target === null || title === undefined || head === undefined || base === undefined) {
        return toolError('create_pull_request requires "owner", "repo", "title", "head" and "base"');
      }
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const bodyText = pickString(args, 'body', 'description', 'text') ?? '';
      const created = forge.createPull(repo, head, base, title, bodyText);
      if (created.error !== undefined) return toolError(created.error);
      return toolResult(pullJson(forge, repo, created.pull!));
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      const number = pickNumber(args, 'pull_number', 'number', 'pullNumber', 'pr_number');
      if (target === null || number === undefined) return toolError('merge_pull_request requires "owner", "repo" and "pull_number"');
      const repo = forge.getRepo(target.owner, target.repo);
      const pull = repo?.pulls.get(number);
      if (repo === undefined || pull === undefined) return toolError('Not Found');
      const merged = forge.squashMerge(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolResult({
        merged: true,
        sha: merged.sha,
        number: pull.number,
        state: 'closed',
        repository: `${target.owner}/${target.repo}`,
        pull_request: pullJson(forge, repo, pull),
      });
    }
    case 'list_pull_requests': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('list_pull_requests requires "owner" and "repo"');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const state = pickString(args, 'state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult({
        repository: `${target.owner}/${target.repo}`,
        owner: target.owner,
        repo: target.repo,
        pull_requests: pulls.map((pull) => pullJson(forge, repo, pull)),
      });
    }
    default:
      return toolError(`unknown tool ${JSON.stringify(name)}`);
  }
}

export function handleMcp(forge: Forge, bodyText: string): McpResponse {
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const record = request as Record<string, unknown>;
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  // A notification (no id) is answered 202 with an empty body.
  if (id === undefined) return { status: 202, body: null };
  const params = (record.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': {
      const result = {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      };
      return { status: 200, body: rpcResult(id, result) };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = KNOWN_VERSIONS.has(requested) ? requested : '2026-07-28';
      const result = {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      };
      return { status: 200, body: rpcResult(id, result) };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { status: 200, body: rpcError(id, MISSING_ARGS, 'tools/call requires an arguments object') };
      }
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${toolName}`) };
      }
      const result = callTool(forge, toolName, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    default: {
      return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
    }
  }
}
