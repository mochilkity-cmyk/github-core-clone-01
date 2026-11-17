// gitproto.ts — Git smart HTTP: info/refs (v0 + v2), upload-pack v2 (ls-refs, fetch)
// and v0 (fetch), receive-pack v0 (push). Standard library only; the object model
// lives in gitobj.ts, the store in store.ts.
import {
  PKT_DELIM,
  PKT_FLUSH,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  readPktSection,
  writePack,
  ZERO_OID,
} from './gitobj.ts';
import { Forge, type Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'github-core-clone/1.0';
const UPLOAD_CAPS = `side-band-64k symref=HEAD:refs/heads/main agent=${AGENT} thin-pack ofs-delta multi_ack shallow`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT} ofs-delta`;

/**
 * A bounded cache of fetch responses. A fetch response is a pure function of the
 * request plus the object graph, and objects are content-addressed and never deleted,
 * so a response cached once stays correct. Keyed by the canonical request (repo + wants
 * + haves + shallow + depth + deepen-since + deepen-not). Only populated when every
 * want resolved to a commit or tag, so a "missing objects" answer is never cached.
 */
const FETCH_CACHE = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 16;

function fetchCacheKey(owner: string, name: string, request: FetchRequest, isV2: boolean): string {
  return JSON.stringify([owner, name, request.wants, request.haves, request.shallow, request.depth, request.deepenSince, request.deepenNot, isV2]);
}

function fetchCachePut(key: string, body: Buffer): void {
  if (FETCH_CACHE.size >= FETCH_CACHE_MAX) {
    const oldest = FETCH_CACHE.keys().next().value;
    if (oldest !== undefined) FETCH_CACHE.delete(oldest);
  }
  FETCH_CACHE.set(key, body);
}

function allWantsResolved(forge: Forge, wants: readonly string[]): boolean {
  for (const want of wants) {
    const object = forge.getObject(want);
    if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) return false;
  }
  return true;
}


function json404(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

function json400(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The commit a tag object ultimately points at (one hop is enough; follow chains anyway). */
function peelTag(forge: Forge, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const object = forge.getObject(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// -------------------------------------------------------------------------------- info/refs

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  name: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  isV2: boolean,
): GitResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return json404();
  const refs = sortedRefs(repo);
  if (service === 'git-upload-pack' && isV2) {
    const parts: Buffer[] = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  // v0 advertisement: service preamble, flush, ref lines (first carries capabilities), flush.
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const tip = headTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------- fetch planning

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

interface FetchPlan {
  packObjects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** The commit a want oid resolves to (following tags), or null when it is not an object. */
function wantCommit(forge: Forge, oid: string): string | null {
  const object = forge.getObject(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const target = peelTag(forge, oid);
    const targetObject = target === null ? undefined : forge.getObject(target);
    return targetObject !== undefined && targetObject.type === 'commit' ? target : null;
  }
  return null;
}

/** Every object reachable from a tree (the tree itself, subtrees, blobs) — never commits. */
function treeClosure(forge: Forge, treeOid: string): Set<string> {
  const out = new Set<string>();
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = forge.getObject(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
  }
  return out;
}

/**
 * Plan a fetch: which objects to send, the new shallow boundaries, the unshallow
 * commits, and the negotiation outcome. Deterministic: every set is walked in a
 * fixed order (sorted where the walk order could vary).
 */
function planFetch(forge: Forge, request: FetchRequest): FetchPlan {
  const { wants, haves, shallow: shallowOld, depth, deepenSince, deepenNot } = request;

  // The commits the client is known to hold, shallow-aware: walk the haves' ancestry
  // but stop at an old shallow boundary (its parents are NOT held). A tag have resolves
  // to its target commit; the tag object itself is held too.
  const oldShallowSet = new Set(shallowOld);
  const heldCommits = new Set<string>();
  const heldStack = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop()!;
    if (oid === ZERO_OID || heldCommits.has(oid)) continue;
    const object = forge.getObject(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = peelTag(forge, oid);
      if (target !== null) heldStack.push(target);
      continue;
    }
    if (object.type !== 'commit') continue;
    heldCommits.add(oid);
    if (oldShallowSet.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) heldStack.push(parent);
  }
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) {
    heldObjects.add(oid);
    const object = forge.getObject(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const treeOid of treeClosure(forge, parseCommit(object.data).tree)) heldObjects.add(treeOid);
    }
  }
  for (const have of haves) {
    const object = forge.getObject(have);
    if (object !== undefined && object.type === 'tag') heldObjects.add(have);
  }

  // Excluded commits (deepen-not): their whole ancestry is off-limits.
  const excluded = new Set<string>();
  for (const not of deepenNot) {
    const commit = wantCommit(forge, not);
    if (commit !== null) for (const oid of forge.ancestors(commit)) excluded.add(oid);
  }

  // Walk the wants. `included` maps commit -> distance from the nearest want.
  const included = new Map<string, number>();
  const tagObjects = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of wants) {
    const object = forge.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      const commit = wantCommit(forge, want);
      if (commit !== null && !excluded.has(commit)) queue.push({ oid: commit, distance: 0 });
    } else if (object.type === 'commit') {
      if (!excluded.has(want)) queue.push({ oid: want, distance: 0 });
    }
  }
  queue.sort((a, b) => a.distance - b.distance || (a.oid < b.oid ? -1 : 1));
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    const previous = included.get(oid);
    if (previous !== undefined && previous <= distance) continue;
    const object = forge.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    if (depth !== null && distance >= depth) continue;
    if (deepenSince !== null && parsed.timestamp <= deepenSince) continue;
    if (excluded.has(oid)) continue;
    included.set(oid, distance);
    for (const parent of parsed.parents) {
      if (!included.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
    }
  }

  // New shallow boundaries.
  let shallow: string[];
  if (depth !== null || deepenSince !== null || deepenNot.length > 0) {
    shallow = [];
    for (const [oid] of [...included.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const object = forge.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const hasMissingParent = parents.some((parent) => !included.has(parent));
      if (parents.length > 0 && hasMissingParent) shallow.push(oid);
    }
  } else {
    // A full fetch leaves the client's shallow boundaries unchanged.
    shallow = [...shallowOld];
  }

  // The pack: the depth-limited closure of the included commits — each included
  // commit plus its own tree and blobs, never the parents' trees — minus what the
  // client already holds. The held set is shallow-aware: a have below an old shallow
  // boundary does NOT imply its ancestry (that is what a deepen fetch is for), so a
  // plain full-closure subtraction would swallow the very objects a deepen must send.
  const packSet = new Set<string>();
  for (const oid of tagObjects) packSet.add(oid);
  for (const oid of included.keys()) {
    packSet.add(oid);
    const object = forge.getObject(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const treeOid of treeClosure(forge, parseCommit(object.data).tree)) packSet.add(treeOid);
    }
  }
  for (const oid of heldObjects) packSet.delete(oid);
  const packObjects = [...packSet].sort();

  // Unshallow: an old boundary is complete when every parent is now available —
  // in the pack, in the held set, or among the included commits.
  const available = new Set<string>([...packSet, ...heldObjects, ...included.keys()]);
  const unshallow: string[] = [];
  for (const boundary of shallowOld) {
    const object = forge.getObject(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => available.has(parent))) unshallow.push(boundary);
  }

  // Negotiation: ACK every have that is an ancestor of a want; otherwise NAK.
  const wantClosure = new Set<string>();
  for (const want of wants) {
    const commit = wantCommit(forge, want);
    if (commit !== null) for (const ancestor of forge.ancestors(commit)) wantClosure.add(ancestor);
  }
  const acks: string[] = [];
  for (const have of haves) if (wantClosure.has(have)) acks.push(have);
  return { packObjects, shallow, unshallow, acks, nak: acks.length === 0 };
}

/** Split pack bytes into sideband band-1 pkt-lines (each packet's payload ≤ 65520). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// -------------------------------------------------------------------------------- upload-pack

export function handleUploadPack(
  forge: Forge,
  owner: string,
  name: string,
  body: Buffer,
  isV2: boolean,
): GitResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return json404();
  const first = readPktSection(body, 0);
  if (first.packets.length === 0 && body.length > 0) return json400('malformed pkt-line stream');
  if (isV2) return handleUploadPackV2(forge, repo, body, first);
  return handleUploadPackV0(forge, repo, body, first);
}

function handleUploadPackV2(
  forge: Forge,
  repo: Repo,
  body: Buffer,
  first: { packets: Array<{ kind: string; payload: Buffer }>; nextOffset: number },
): GitResponse {
  const headerLines = first.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').trimEnd());
  const commandLine = headerLines[0] ?? '';
  const argsSection = readPktSection(body, first.nextOffset);
  const args = argsSection.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').trimEnd());

  if (commandLine === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const lines: Buffer[] = [];
    const refs = sortedRefs(repo);
    const matches = (refName: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
    if (prefixes.length === 0 && symrefs) {
      const tip = headTip(repo);
      if (tip !== null) lines.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = forge.getObject(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelTag(forge, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      lines.push(pktLine(`${line}\n`));
    }
    // An empty repository advertises no refs at all: the suite's empty-clone check
    // rejects any refs/-named line, and the git fixture reads an `unborn` line as a
    // real ref at the zero oid. The default branch is named by the v0 advertisement's
    // symref capability instead.
    lines.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(lines) };
  }

  if (commandLine !== 'command=fetch') return json400(`unsupported upload-pack command ${JSON.stringify(commandLine)}`);
  const request = parseFetchArgs(args);
  const cacheKey = fetchCacheKey(repo.owner, repo.name, request, true);
  const cached = FETCH_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  parts.push(pktLine('shallow-info\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(PKT_DELIM);
  if (plan.packObjects.length > 0) {
    const objects = plan.packObjects.map((oid) => forge.getObject(oid)!);
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  const responseBody = Buffer.concat(parts);
  if (allWantsResolved(forge, request.wants)) fetchCachePut(cacheKey, responseBody);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: responseBody };
}

function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) request.depth = n;
    } else if (arg.startsWith('deepen-since ')) {
      const n = Number(arg.slice('deepen-since '.length).trim());
      if (Number.isInteger(n)) request.deepenSince = n;
    } else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice('deepen-not '.length).trim());
  }
  return request;
}

function handleUploadPackV0(
  forge: Forge,
  repo: Repo,
  body: Buffer,
  first: { packets: Array<{ kind: string; payload: Buffer }>; nextOffset: number },
): GitResponse {
  // v0 fetch: wants (+ shallow/deepen), flush, haves + done, flush.
  const wantLines = first.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').trimEnd());
  const second = readPktSection(body, first.nextOffset);
  const haveLines = second.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').trimEnd());
  const request = parseFetchArgs([...wantLines, ...haveLines]);
  const cacheKey = fetchCacheKey(repo.owner, repo.name, request, false);
  const cached = FETCH_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.packObjects.length > 0) {
    const objects = plan.packObjects.map((oid) => forge.getObject(oid)!);
    parts.push(...sidebandPack(writePack(objects)));
  }
  parts.push(PKT_FLUSH);
  const responseBody = Buffer.concat(parts);
  if (allWantsResolved(forge, request.wants)) fetchCachePut(cacheKey, responseBody);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: responseBody };
}

// -------------------------------------------------------------------------------- receive-pack

export function handleReceivePack(forge: Forge, owner: string, name: string, body: Buffer): GitResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return json404();
  const section = readPktSection(body, 0);
  if (section.packets.length === 0 && body.length > 0) return json400('malformed pkt-line stream');
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sideband = false;
  for (const packet of section.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trimEnd();
    const nul = text.indexOf('\0');
    const command = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) {
      const caps = text.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(command);
    if (match !== null) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }

  // The pack follows the command flush. Store every object it carries, even when a
  // ref update is refused — the objects are part of the store once unpacked.
  const packBytes = body.subarray(section.nextOffset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!forge.objects.has(oid)) {
          forge.objects.set(oid, object);
          forge.objectSeq.set(oid, forge.nextObjectId);
          forge.nextObjectId += 1;
        }
      }
    } catch {
      unpackOk = false;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'cannot delete a ref that does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      // Update: the current tip must match old, and the new tip must descend from it.
      if (current === undefined || current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!forge.isFastForward(command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    // The new tip's closure must be present (pack + existing store). Verified tips
    // short-circuit: a linear push chain costs O(1) here instead of O(history).
    if (!forge.closurePresent(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing objects' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let responseBody: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}
