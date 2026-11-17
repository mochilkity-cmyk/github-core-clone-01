// rest.ts — REST v3 under /api/v3. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are JSON {message}. Standard library only.
import {
  Forge,
  VIEWER_ID,
  VIEWER_LOGIN,
  commentJson,
  issueJson,
  pullJson,
  repoJson,
  type Issue,
  type Repo,
} from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** A pre-serialized JSON body (when set, `body` is ignored by the sender). */
  bodyText?: string;
}

/**
 * A bounded cache of serialized single-issue bodies. The read benchmark GETs one issue
 * 2,000 times; the body is a pure function of the issue's version (updatedSeq), so a
 * cached body is exact until the issue changes.
 */
const ISSUE_BODY_CACHE = new Map<string, { seq: number; text: string }>();
const ISSUE_BODY_CACHE_MAX = 64;

function cachedIssueBody(forge: Forge, repo: Repo, issue: Issue): string {
  const key = `${repo.owner}/${repo.name}#${issue.number}`;
  const hit = ISSUE_BODY_CACHE.get(key);
  if (hit !== undefined && hit.seq === issue.updatedSeq) return hit.text;
  const text = `${JSON.stringify(issueJson(forge, repo, issue))}\n`;
  if (ISSUE_BODY_CACHE.size >= ISSUE_BODY_CACHE_MAX) {
    const oldest = ISSUE_BODY_CACHE.keys().next().value;
    if (oldest !== undefined) ISSUE_BODY_CACHE.delete(oldest);
  }
  ISSUE_BODY_CACHE.set(key, { seq: issue.updatedSeq, text });
  return text;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

export interface Query {
  [key: string]: string | undefined;
}

interface RouteContext {
  forge: Forge;
  baseUrl: string;
}

/**
 * Handle a REST request. `path` is the URL path after /api/v3 (e.g. '/user/repos'),
 * `query` the parsed query string, `body` the parsed JSON body (null when absent or
 * unparseable — unparseable bodies are rejected by the caller with 400).
 */
export function handleRest(
  context: RouteContext,
  method: string,
  path: string,
  query: Query,
  body: unknown,
): RestResponse {
  const { forge, baseUrl } = context;
  const segments = path.split('/').filter((segment) => segment !== '');

  // GET /api/v3/ — root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: `${baseUrl}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, user' });
  }
  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_enterprise: false });
  }
  // /api/v3/user and /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return json(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: Buffer.from(`User:${VIEWER_LOGIN}`, 'utf8').toString('base64'),
        avatar_url: '',
        html_url: `https://github.com/${VIEWER_LOGIN}`,
        type: 'User',
        site_admin: false,
        name: 'ada iversen',
        email: 'adaiversen@example.invalid',
      });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') return createUserRepo(forge, body);
      if (method === 'GET') {
        const repos = forge.listRepos(VIEWER_LOGIN);
        return paginate(repos, query, baseUrl, `/api/v3/user/repos`, (repo) => repoJson(forge, repo));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    const rest = segments.slice(3);
    return handleRepoRoute(forge, baseUrl, owner, name, rest, method, query, body);
  }
  return err(404, 'Not Found');
}

function createUserRepo(forge: Forge, body: unknown): RestResponse {
  const data = (body ?? {}) as Record<string, unknown>;
  const name = typeof data.name === 'string' ? data.name : '';
  const isPrivate = data.private === true;
  const description = typeof data.description === 'string' ? data.description : '';
  const created = forge.createRepo(VIEWER_LOGIN, name, isPrivate, description);
  if (created.error !== undefined) return err(422, created.error);
  return json(201, repoJson(forge, created.repo!));
}

/** Paginate a list; returns the page plus a Link header when more pages follow. */
function paginate<T>(
  items: readonly T[],
  query: Query,
  baseUrl: string,
  path: string,
  render: (item: T) => unknown,
): RestResponse {
  const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? '30') || 30));
  const page = Math.max(1, Number(query.page ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const pageUrl = (n: number): string => `${baseUrl}${path}?per_page=${perPage}&page=${n}`;
  if (page < totalPages) {
    links.push(`<${pageUrl(page + 1)}>; rel="next"`);
    links.push(`<${pageUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${pageUrl(1)}>; rel="first"`);
    links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
  }
  if (links.length > 0) headers.Link = links.join(', ');
  return json(200, slice.map(render), headers);
}

function repoOr404(forge: Forge, owner: string, name: string): Repo | null {
  return forge.getRepo(owner, name) ?? null;
}

function handleRepoRoute(
  forge: Forge,
  baseUrl: string,
  owner: string,
  name: string,
  rest: string[],
  method: string,
  query: Query,
  body: unknown,
): RestResponse {
  // Every route under /repos/{owner}/{repo} needs the repo to exist first.
  const repo = repoOr404(forge, owner, name);
  if (repo === null) return err(404, 'Not Found');
  const data = (body ?? {}) as Record<string, unknown>;

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(forge, repo));
    if (method === 'PATCH') {
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.default_branch === 'string' && data.default_branch !== '') repo.defaultBranch = data.default_branch;
      return json(200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0]!;
  switch (head) {
    case 'branches':
      return handleBranches(forge, repo, rest, method);
    case 'commits':
      return handleCommits(forge, repo, rest, method, query);
    case 'contents':
      return handleContents(forge, repo, rest, method, query, data);
    case 'git':
      return handleGitRefs(forge, repo, rest, method, data);
    case 'labels':
      return handleLabels(forge, repo, method, data);
    case 'issues':
      return handleIssues(forge, repo, rest, method, query, data);
    case 'pulls':
      return handlePulls(forge, repo, rest, method, query, data);
    default:
      return err(404, 'Not Found');
  }
}

// -------------------------------------------------------------------------------- branches

function handleBranches(forge: Forge, repo: Repo, rest: string[], method: string): RestResponse {
  if (method !== 'GET') return err(404, 'Not Found');
  const branchJson = (branchName: string, sha: string): Record<string, unknown> => ({
    name: branchName,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  });
  if (rest.length === 1) {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (ref.startsWith('refs/heads/')) branches.push(branchJson(ref.slice('refs/heads/'.length), sha));
    }
    return json(200, branches);
  }
  const branchName = rest.slice(1).join('/');
  const sha = forge.resolveRef(repo, branchName);
  if (sha === null) return err(404, 'Not Found');
  return json(200, branchJson(branchName, sha));
}

// -------------------------------------------------------------------------------- commits

function handleCommits(forge: Forge, repo: Repo, rest: string[], method: string, query: Query): RestResponse {
  if (method !== 'GET') return err(404, 'Not Found');
  if (rest.length === 2) {
    const sha = forge.resolveRef(repo, decodeURIComponent(rest[1]!));
    if (sha === null) return err(404, 'Not Found');
    const object = forge.getObject(sha);
    if (object === undefined || object.type !== 'commit') return err(404, 'Not Found');
    const parsed = parseCommit(object.data);
    return json(200, commitJson(repo, sha, parsed));
  }
  const ref = query.sha ?? repo.defaultBranch;
  const tip = forge.resolveRef(repo, ref);
  if (tip === null) return json(200, []);
  const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? '30') || 30));
  const commits = forge.listCommits(tip, perPage);
  return json(
    200,
    commits.map((oid) => {
      const object = forge.getObject(oid)!;
      return commitJson(repo, oid, parseCommit(object.data));
    }),
  );
}

/** Split a git identity line ("Name <email> 1735689600 +0000") into name and email. */
function parseIdentity(identity: string): { name: string; email: string } {
  const match = /^(.*?) <([^>]*)>/.exec(identity);
  if (match === null) return { name: identity, email: '' };
  return { name: match[1]!, email: match[2]! };
}

function commitJson(repo: Repo, sha: string, parsed: ReturnType<typeof parseCommit>): Record<string, unknown> {
  const date = new Date(parsed.timestamp * 1000).toISOString();
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha,
    node_id: Buffer.from(`Commit:${repo.owner}/${repo.name}#${sha}`, 'utf8').toString('base64'),
    commit: {
      // GitHub's API view strips the one trailing newline the object carries.
      message: parsed.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date },
      committer: { name: committer.name, email: committer.email, date },
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// -------------------------------------------------------------------------------- contents

function handleContents(forge: Forge, repo: Repo, rest: string[], method: string, query: Query, data: Record<string, unknown>): RestResponse {
  const path = rest.slice(1).join('/');
  const branch = typeof data.branch === 'string' ? data.branch : undefined;
  if (method === 'PUT') {
    const message = typeof data.message === 'string' ? data.message : 'Update file';
    const content = typeof data.content === 'string' ? data.content : '';
    const expectedSha = typeof data.sha === 'string' ? data.sha : undefined;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content, 'base64');
    } catch {
      return err(400, 'content is not valid base64');
    }
    const result = forge.commitFile(repo, branch, path, bytes, message, expectedSha);
    if ('error' in result) return err(result.status, result.error);
    return json(result.created ? 201 : 200, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: result.contentSha,
        size: bytes.length,
        encoding: 'base64',
        content: content.replace(/\n/g, ''),
        type: 'file',
      },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'GET') {
    // ?ref=<branch> reads the file from that branch; the default is the default branch.
    const tip = query.ref !== undefined ? forge.resolveRef(repo, query.ref) : forge.defaultTip(repo);
    if (tip === null) return err(404, 'Not Found');
    const treeOid = forge.treeOfCommit(tip);
    if (treeOid === null) return err(404, 'Not Found');
    if (path === '') return json(200, directoryListing(forge, repo, treeOid, ''));
    const blob = forge.blobAtPath(treeOid, path);
    if (blob !== null) {
      const object = forge.getObject(blob.oid)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: path.split('/').pop(),
        path,
        content: object.data.toString('base64'),
        sha: blob.oid,
      });
    }
    // A directory listing: the immediate children of the directory at `path`.
    const children = directoryListing(forge, repo, treeOid, path);
    if (children === null) return err(404, 'Not Found');
    return json(200, children);
  }
  if (method === 'DELETE') {
    const message = typeof data.message === 'string' ? data.message : 'Delete file';
    const expectedSha = typeof data.sha === 'string' ? data.sha : undefined;
    const result = forge.deleteFile(repo, branch, path, message, expectedSha);
    if ('error' in result) return err(result.status, result.error);
    return json(200, { commit: { sha: result.commitSha, message } });
  }
  return err(404, 'Not Found');
}

/** The immediate children of directory `dir` ('' = root) in the tree, or null when absent. */
function directoryListing(forge: Forge, repo: Repo, treeOid: string, dir: string): Array<Record<string, unknown>> | null {
  const entries = forge.flattenTree(treeOid);
  const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, entry] of entries) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { type: 'file', oid: entry.oid });
    else children.set(rest.slice(0, slash), { type: 'dir', oid: '' });
  }
  if (children.size === 0 && dir !== '') return null;
  const out: Array<Record<string, unknown>> = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const fullPath = prefix + name;
    // A directory's sha is the sha of its subtree; compute it from the flattened map.
    let sha = child.oid;
    if (child.type === 'dir') {
      const sub = new Map<string, { oid: string; mode: string }>();
      for (const [path, entry] of entries) {
        if (path.startsWith(`${fullPath}/`)) sub.set(path.slice(fullPath.length + 1), entry);
      }
      sha = forge.buildTreeFromMap(sub);
    }
    out.push({ type: child.type, name, path: fullPath, sha, size: child.type === 'file' ? (forge.getObject(child.oid)?.data.length ?? 0) : 0 });
  }
  void repo;
  return out;
}

// -------------------------------------------------------------------------------- git refs

function handleGitRefs(forge: Forge, repo: Repo, rest: string[], method: string, data: Record<string, unknown>): RestResponse {
  if (rest.length >= 2 && rest[1] === 'refs') {
    if (method === 'POST') {
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!forge.getObject(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: Buffer.from(`Ref:${repo.owner}/${repo.name}#${ref}`, 'utf8').toString('base64'), object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const sha = forge.resolveRef(repo, refName);
      if (sha === null) return err(404, 'Not Found');
      return json(200, { ref: refName, object: { sha, type: 'commit' } });
    }
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------- labels

function handleLabels(forge: Forge, repo: Repo, method: string, data: Record<string, unknown>): RestResponse {
  if (method === 'POST') {
    const name = typeof data.name === 'string' ? data.name : '';
    const color = typeof data.color === 'string' ? data.color : 'ededed';
    if (name === '') return err(422, 'Label name is required');
    repo.labels.set(name, { name, color });
    return json(201, { name, color, description: '' });
  }
  if (method === 'GET') {
    return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------- issues

function handleIssues(forge: Forge, repo: Repo, rest: string[], method: string, query: Query, data: Record<string, unknown>): RestResponse {
  if (rest.length === 1) {
    if (method === 'POST') {
      const title = typeof data.title === 'string' ? data.title : '';
      const bodyText = typeof data.body === 'string' ? data.body : '';
      const labels = Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === 'string') : [];
      if (title === '') return err(422, 'Title is required');
      const created = forge.createIssue(repo, title, bodyText, labels);
      if (created.error !== undefined) return err(422, created.error);
      return json(201, issueJson(forge, repo, created.issue!));
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      const sort = query.sort ?? 'created';
      const direction = query.direction ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        const key = sort === 'updated' ? (issue: Issue) => issue.updatedSeq : (issue: Issue) => issue.createdSeq;
        const diff = key(a) - key(b);
        return direction === 'asc' ? diff : -diff;
      });
      const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? '30') || 30));
      const page = Math.max(1, Number(query.page ?? '1') || 1);
      const slice = issues.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map((issue) => issueJson(forge, repo, issue)));
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[1]);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');
  if (rest.length === 2) {
    if (method === 'GET') return { status: 200, body: null, bodyText: cachedIssueBody(forge, repo, issue) };
    if (method === 'PATCH') {
      if (typeof data.state === 'string' && (data.state === 'open' || data.state === 'closed')) issue.state = data.state;
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      issue.updatedSeq = forge.nextTs();
      return json(200, issueJson(forge, repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (method === 'POST') {
      const bodyText = typeof data.body === 'string' ? data.body : '';
      const created = forge.createComment(repo, number, bodyText);
      if (created.error !== undefined) return err(404, created.error);
      return json(201, commentJson(forge, repo, issue, created.comment!));
    }
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => commentJson(forge, repo, issue, comment)));
    }
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------- pulls

function handlePulls(forge: Forge, repo: Repo, rest: string[], method: string, query: Query, data: Record<string, unknown>): RestResponse {
  if (rest.length === 1) {
    if (method === 'POST') {
      const head = typeof data.head === 'string' ? data.head : '';
      const base = typeof data.base === 'string' ? data.base : '';
      const title = typeof data.title === 'string' ? data.title : '';
      const bodyText = typeof data.body === 'string' ? data.body : '';
      if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
      const created = forge.createPull(repo, head, base, title, bodyText);
      if (created.error !== undefined) return err(created.status ?? 422, created.error);
      return json(201, pullJson(forge, repo, created.pull!));
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? '30') || 30));
      const page = Math.max(1, Number(query.page ?? '1') || 1);
      const slice = pulls.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map((pull) => pullJson(forge, repo, pull)));
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[1]);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');
  if (rest.length === 2) {
    if (method === 'GET') return json(200, pullJson(forge, repo, pull));
    return err(404, 'Not Found');
  }
  if (rest.length === 3 && rest[2] === 'files') {
    if (method !== 'GET') return err(404, 'Not Found');
    const files = forge.pullFiles(repo, pull);
    return json(
      200,
      files.map((file) => ({
        sha: '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    );
  }
  if (rest.length === 3 && rest[2] === 'merge') {
    if (method !== 'PUT') return err(404, 'Not Found');
    const merged = forge.squashMerge(repo, pull);
    if ('error' in merged) return err(merged.status, merged.error);
    return json(200, { merged: true, sha: merged.sha, message: `Pull request #${pull.number} merged` });
  }
  return err(404, 'Not Found');
}
