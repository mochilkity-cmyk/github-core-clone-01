// store.ts — the forge's in-memory store and every operation the surfaces share.
// Standard library only. No wall clock, no randomness: every timestamp comes from a
// deterministic sequence counter, so two runs fed the same requests produce the same
// object ids, the same commit SHAs and the same JSON.
import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const DEFAULT_BRANCH = 'main';

/** The deterministic clock: 2025-01-01T00:00:00Z plus one second per timestamped event. */
export const EPOCH_BASE_SEC = 1_735_689_600;

export const SCENARIO_LABELS: readonly string[] = Object.freeze([
  'bug',
  'enhancement',
  'documentation',
  'question',
  'good first issue',
  'help wanted',
]);

const LABEL_COLORS: Readonly<Record<string, string>> = Object.freeze({
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
});

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  databaseId: number;
  createdSeq: number;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    const parts = text.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    for (const line of parts) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) {
    const m = oldLines.get(line) ?? 0;
    if (n > m) additions += n - m;
  }
  for (const [line, m] of oldLines) {
    const n = newLines.get(line) ?? 0;
    if (m > n) deletions += m - n;
  }
  return { additions, deletions };
}

export class Forge {
  /** Content-addressed objects, shared across repositories (as in git). */
  readonly objects = new Map<string, GitObject>();
  /** Insertion order of each object (for deterministic commit listing order). */
  readonly objectSeq = new Map<string, number>();
  readonly repos = new Map<string, Repo>();
  /** Monotonic deterministic sequence: every timestamped event takes the next value. */
  seq = 0;
  nextRepoId = 1;
  nextObjectId = 1;
  reqSeq = 0;

  nextTs(): number {
    this.seq += 1;
    return EPOCH_BASE_SEC + this.seq;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.objectSeq.set(oid, this.nextObjectId);
      this.nextObjectId += 1;
    }
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): { repo?: Repo; error?: string } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      return { error: `Invalid repository name ${JSON.stringify(name)}` };
    }
    if (this.repos.has(this.repoKey(owner, name))) {
      return { error: 'Repository already exists' };
    }
    const repo: Repo = {
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      databaseId: this.nextRepoId,
      createdSeq: this.nextTs(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    for (const label of SCENARIO_LABELS) {
      repo.labels.set(label, { name: label, color: LABEL_COLORS[label] ?? 'ededed' });
    }
    this.repos.set(this.repoKey(owner, name), repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /** Resolve a branch name, full ref, or 40-hex oid to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (ref.startsWith('refs/')) {
      return repo.refs.get(ref) ?? null;
    }
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return this.objects.has(ref) ? ref : null;
    }
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  // -------------------------------------------------------------------------------- trees

  /** Flatten a tree into path -> {oid, mode} (blobs only; directories are expanded). */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) nested trees for a flat path map; returns the root tree oid. */
  buildTreeFromMap(entries: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of entries) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const treeEntries: TreeEntry[] = [];
      for (const [name, entry] of node.files) treeEntries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) treeEntries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(treeEntries));
    };
    return build(root);
  }

  /** The blob oid at `path` in the tree at `treeOid` (or null). */
  blobAtPath(treeOid: string, path: string): { oid: string; mode: string } | null {
    const segments = path.split('/');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        return entry.mode === '40000' ? null : { oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    const ts = this.nextTs();
    const data = buildCommit({
      tree: treeOid,
      parents: [...parents],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: ts,
    });
    return this.putObject('commit', data);
  }

  /** Ancestors of `tip` (including `tip`), in first-visit order. */
  ancestors(tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parsed = parseCommit(object.data);
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]!);
    }
    return out;
  }

  isAncestor(anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.ancestors(desc).includes(anc);
  }

  /** The nearest common ancestor of a and b (first found walking from b). */
  mergeBase(a: string, b: string): string | null {
    const aSet = new Set(this.ancestors(a));
    for (const oid of this.ancestors(b)) {
      if (aSet.has(oid)) return oid;
    }
    return null;
  }

  /** Reachable objects from tips, ignoring missing ones (never throws). */
  reachableSafe(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const parsed = parseCommit(object.data);
        stack.push(parsed.tree);
        for (const parent of parsed.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** Commits whose object closure has been verified present (never deleted, so it stays true). */
  readonly verified = new Set<string>();

  /**
   * Whether the whole closure of `tip` is present in the store. Walks ancestors but
   * stops at any commit already verified, so a linear push chain costs O(1) per push
   * instead of O(history). A tip that passes is itself verified.
   */
  closurePresent(tip: string): boolean {
    const stack = [tip];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ZERO_OID || seen.has(oid) || this.verified.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) return false;
      seen.add(oid);
      if (object.type === 'commit') {
        const parsed = parseCommit(object.data);
        stack.push(parsed.tree);
        for (const parent of parsed.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    this.verified.add(tip);
    return true;
  }

  /** Fast-forward check with a fast path: a commit whose parent is `old` is a fast-forward. */
  isFastForward(oldOid: string, newOid: string): boolean {
    if (oldOid === newOid) return true;
    const object = this.objects.get(newOid);
    if (object !== undefined && object.type === 'commit') {
      if (parseCommit(object.data).parents.includes(oldOid)) return true;
    }
    return this.isAncestor(oldOid, newOid);
  }

  // -------------------------------------------------------------------------------- contents

  /**
   * Write one file on a branch (create or update) through the contents API.
   * `branch` names the branch; a missing branch is created from the default tip.
   * Returns the commit and content SHAs, or an error string.
   */
  commitFile(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; contentSha: string; created: boolean } | { error: string; status: number } {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined && branch !== undefined) {
      // A contents write on a new branch starts from the default branch tip.
      tip = this.defaultTip(repo) ?? undefined;
    }
    const baseTree = tip === undefined ? null : this.treeOfCommit(tip);
    const entries = baseTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(baseTree);
    const existing = entries.get(path);
    if (expectedSha !== undefined) {
      if (existing === undefined || existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
        return { error: 'The blob sha does not match the current file', status: 409 };
      }
    }
    const created = existing === undefined;
    const blobOid = this.putObject('blob', content);
    entries.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromMap(entries);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = this.makeCommit(treeOid, parents, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid, created };
  }

  /** Delete one file on a branch through the contents API. */
  deleteFile(
    repo: Repo,
    branch: string | undefined,
    path: string,
    message: string,
    expectedSha?: string,
  ): { commitSha: string } | { error: string; status: number } {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return { error: 'Not Found', status: 404 };
    const treeOid = this.treeOfCommit(tip);
    if (treeOid === null) return { error: 'Not Found', status: 404 };
    const entries = this.flattenTree(treeOid);
    const existing = entries.get(path);
    if (existing === undefined) return { error: 'Not Found', status: 404 };
    if (expectedSha !== undefined && existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      return { error: 'The blob sha does not match the current file', status: 409 };
    }
    entries.delete(path);
    const newTree = this.buildTreeFromMap(entries);
    const commitSha = this.makeCommit(newTree, [tip], message);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  treeOfCommit(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Commits reachable from `tip`, newest first (by insertion order). */
  listCommits(tip: string, limit = 30): string[] {
    const found = this.ancestors(tip);
    found.sort((a, b) => (this.objectSeq.get(b) ?? 0) - (this.objectSeq.get(a) ?? 0));
    return found.slice(0, limit);
  }

  // -------------------------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): { issue?: Issue; error?: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label ${JSON.stringify(label)} does not exist` };
    }
    const seq = this.nextTs();
    const issue: Issue = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  createComment(repo: Repo, issueNumber: number, body: string): { comment?: IssueComment; error?: string } {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) return { error: 'Not Found' };
    const comment: IssueComment = {
      id: repo.nextCommentId,
      body,
      user: VIEWER_LOGIN,
      createdSeq: this.nextTs(),
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedSeq = comment.createdSeq;
    return { comment };
  }

  // -------------------------------------------------------------------------------- pulls

  createPull(
    repo: Repo,
    head: string,
    base: string,
    title: string,
    body: string,
  ): { pull?: PullRequest; error?: string; status?: number } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (headSha === null || baseSha === null) {
      return { error: 'Head or base branch does not exist', status: 422 };
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === head && existing.base === base) {
        return { error: 'A pull request already exists for this head branch', status: 422 };
      }
    }
    const seq = this.nextTs();
    const pull: PullRequest = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  /** The file diff between the merge base and the head tip (what a PR changes). */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const base = this.mergeBase(pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : this.treeOfCommit(base);
    const headTree = this.treeOfCommit(pull.headSha);
    const baseMap = baseTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(baseTree);
    const headMap = headTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(headTree);
    const out: FileChange[] = [];
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseMap.get(path);
      const after = headMap.get(path);
      if (before === undefined && after !== undefined) {
        const content = this.objects.get(after.oid)?.data.toString('utf8') ?? '';
        const additions = countLines(content);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (before !== undefined && after === undefined) {
        const content = this.objects.get(before.oid)?.data.toString('utf8') ?? '';
        const deletions = countLines(content);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
        const oldContent = this.objects.get(before.oid)?.data.toString('utf8') ?? '';
        const newContent = this.objects.get(after.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiff(oldContent, newContent);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a squash merge of this PR would conflict (three-way, base vs head). */
  mergeConflict(repo: Repo, pull: PullRequest): boolean {
    const base = this.mergeBase(pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : this.treeOfCommit(base);
    const baseMap = baseTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(baseTree);
    const headTree = this.treeOfCommit(pull.headSha);
    const headMap = headTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(headTree);
    const baseTip = this.resolveRef(repo, pull.base);
    const baseTipTree = baseTip === null ? null : this.treeOfCommit(baseTip);
    const tipMap = baseTipTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(baseTipTree);
    const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path)?.oid;
      const h = headMap.get(path)?.oid;
      const t = tipMap.get(path)?.oid;
      const headChanged = h !== b;
      const baseChanged = t !== b;
      if (headChanged && baseChanged && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit or an error. */
  squashMerge(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const baseTip = this.resolveRef(repo, pull.base);
    if (baseTip === null) return { error: 'Base branch does not exist', status: 422 };
    if (this.mergeConflict(repo, pull)) {
      return { error: 'Merge conflict', status: 405 };
    }
    const base = this.mergeBase(pull.headSha, baseTip);
    const baseTree = base === null ? null : this.treeOfCommit(base);
    const baseMap = baseTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(baseTree);
    const headTree = this.treeOfCommit(pull.headSha);
    const headMap = headTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(headTree);
    const tipTree = this.treeOfCommit(baseTip);
    const tipMap = tipTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(tipTree);
    // Start from the base tip's tree, apply the head's changes (non-conflicting by the check above).
    const merged = new Map(tipMap);
    for (const [path, entry] of headMap) {
      if (baseMap.get(path)?.oid !== entry.oid) merged.set(path, entry);
    }
    for (const path of baseMap.keys()) {
      if (!headMap.has(path) && baseMap.get(path)?.oid === tipMap.get(path)?.oid) merged.delete(path);
    }
    const treeOid = this.buildTreeFromMap(merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
    const sha = this.makeCommit(treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    const ts = this.nextTs();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(ts);
    pull.mergeCommitSha = sha;
    pull.updatedSeq = ts;
    return { sha };
  }

  // -------------------------------------------------------------------------------- global ids

  repoGlobalId(repo: Repo): string {
    return Buffer.from(`Repository:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return Buffer.from(`Issue:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64');
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return Buffer.from(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64');
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return Buffer.from(`IssueComment:${repo.owner}/${repo.name}#${issue.number}:${comment.id}`, 'utf8').toString('base64');
  }

  /** Decode a global id into {kind, owner, name, number?, commentId?} or null. */
  decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number | null; commentId: number | null } | null {
    let text: string;
    try {
      text = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const match = /^(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^#]+)(?:#(\d+)(?::(\d+))?)?$/.exec(text);
    if (match === null) return null;
    return {
      kind: match[1]!,
      owner: match[2]!,
      name: match[3]!,
      number: match[4] === undefined ? null : Number(match[4]),
      commentId: match[5] === undefined ? null : Number(match[5]),
    };
  }

  isoOfSeq(seq: number): string {
    return isoOf(EPOCH_BASE_SEC + seq);
  }
}

// -------------------------------------------------------------------------------- JSON views

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: forge.isoOfSeq(repo.createdSeq),
    updated_at: forge.isoOfSeq(repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: issue.user, id: issue.user === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    created_at: forge.isoOfSeq(issue.createdSeq),
    updated_at: forge.isoOfSeq(issue.updatedSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const state = pull.merged ? 'closed' : pull.state;
  return {
    id: pull.id,
    node_id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: !forge.mergeConflict(repo, pull),
    mergeable_state: forge.mergeConflict(repo, pull) ? 'dirty' : 'clean',
    head: {
      ref: pull.head,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.head}`,
      user: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 },
      repo: repoJson(forge, repo),
    },
    base: {
      ref: pull.base,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.base}`,
      user: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 },
      repo: repoJson(forge, repo),
    },
    user: { login: pull.user, id: pull.user === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    created_at: forge.isoOfSeq(pull.createdSeq),
    updated_at: forge.isoOfSeq(pull.updatedSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: forge.commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: { login: comment.user, id: comment.user === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    created_at: forge.isoOfSeq(comment.createdSeq),
    updated_at: forge.isoOfSeq(comment.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}
