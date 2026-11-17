// gitobj.ts — git object model, pkt-line framing and packfile read/write.
// Standard library only (node:crypto, node:zlib). No wall clock, no randomness:
// every function is a pure function of its inputs, so live and replay agree.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }
export interface TreeEntry { mode: string; name: string; oid: string; }

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// -------------------------------------------------------------------------------- commits/tags

export interface CommitMeta {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

export function buildCommit(meta: CommitMeta): Buffer {
  const lines: string[] = [`tree ${meta.tree}`];
  for (const parent of meta.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${meta.author} ${meta.timestamp} +0000`);
  lines.push(`committer ${meta.committer} ${meta.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${meta.message}`, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) timestamp = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, timestamp, message };
}

export interface TagMeta {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}

export function buildTag(meta: TagMeta): Buffer {
  const lines = [
    `object ${meta.object}`,
    `type ${meta.type}`,
    `tag ${meta.tag}`,
    `tagger ${meta.tagger} ${meta.timestamp} +0000`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${meta.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------- trees

/** Git tree entry order: names sort as bytes, directories as if suffixed with '/'. */
export function treeSortKey(mode: string, name: string): string {
  return mode === '40000' ? `${name}/` : name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.mode, a.name);
    const kb = treeSortKey(b.mode, b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// -------------------------------------------------------------------------------- reachability

/** All objects reachable from `tips` (commits walk parents+trees, tags walk their target). */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing-object ${oid}`);
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

// -------------------------------------------------------------------------------- pkt-line

/** Encode one pkt-line payload (no trailing newline added by us; callers include it). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Split a pkt-line stream into packets (data/flush/delim/end), in order. */
export function parsePktLines(data: Buffer): { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] {
  const out: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const length = Number.parseInt(data.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > data.length) break;
    out.push({ kind: 'data', payload: data.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/**
 * Read pkt-line packets from `data` starting at `start`, stopping after the first
 * flush/delim/end packet (or the end of the buffer). Returns the packets and the
 * offset just past the last packet read — the raw bytes after a flush (a push's
 * packfile) start there.
 */
export function readPktSection(data: Buffer, start = 0): { packets: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[]; nextOffset: number } {
  const packets: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] = [];
  let offset = start;
  while (offset + 4 <= data.length) {
    const length = Number.parseInt(data.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > data.length) break;
    packets.push({ kind: 'data', payload: data.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, nextOffset: offset };
}

// -------------------------------------------------------------------------------- packfiles

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size !== 0) first |= 0x80;
  bytes.push(first);
  while (size !== 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size !== 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = data[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

function readPackObjectHeader(data: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  const first = data[offset];
  const typeCode = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((data[pos - 1] & 0x80) !== 0) {
    size |= (data[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { typeCode, size, next: pos };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readVarint(delta, 0);
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const dst = readVarint(delta, src.next);
  let pos = dst.next;
  const chunks: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) { offset |= delta[pos] << (8 * i); pos += 1; }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) { size |= delta[pos] << (8 * i); pos += 1; }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== dst.value) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks, total);
}

/** Serialize objects as a packfile (all full objects, no deltas — always valid). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackObjectHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ParsedPack { objects: Map<string, GitObject>; }

/**
 * Parse a packfile, resolving OFS_DELTA and REF_DELTA entries. `lookup` resolves delta bases
 * the pack does not carry (thin packs: the base is an object the server already stores).
 * Throws on corruption.
 */
export function readPack(data: Buffer, lookup?: (oid: string) => GitObject | undefined): ParsedPack {
  if (data.length < 32 || data.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = data.readUInt32BE(8);
  const raw: { typeCode: number; baseOffset?: number; baseOid?: string; data: Buffer }[] = [];
  const offsets: number[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    offsets.push(pos);
    const header = readPackObjectHeader(data, pos);
    pos = header.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.typeCode === 6) {
      // OFS_DELTA: negative offset varint
      let byte = data[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = data[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = offsets[i] - offset;
    } else if (header.typeCode === 7) {
      baseOid = data.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    // One inflate per entry: {info:true} reports the exact consumed byte count.
    const inflated = inflateSync(data.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
    pos += consumed;
    raw.push({ typeCode: header.typeCode, baseOffset, baseOid, data: inflated.buffer });
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolve = (index: number): GitObject => {
    const offset = offsets[index];
    const cached = byOffset.get(offset);
    if (cached) return cached;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = raw[index];
    let object: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseIndex = offsets.indexOf(entry.baseOffset!);
        if (baseIndex === -1) throw new Error('delta base offset not in pack');
        base = resolve(baseIndex);
      } else {
        // REF_DELTA: base may be an earlier object in this pack or an external one.
        for (const candidate of byOffset.values()) {
          if (hashObject(candidate.type, candidate.data) === entry.baseOid) { base = candidate; break; }
        }
        if (!base && lookup) base = lookup(entry.baseOid!);
        if (!base) throw new Error(`delta base ${entry.baseOid} not in pack`);
      }
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error(`unknown object type ${entry.typeCode}`);
      object = { type, data: entry.data };
    }
    resolving.delete(index);
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(offset, object);
    return object;
  };
  for (let i = 0; i < count; i += 1) resolve(i);
  return { objects };
}

/** Verify a packfile trailer checksum. */
export function verifyPackChecksum(data: Buffer): boolean {
  if (data.length < 20) return false;
  const body = data.subarray(0, data.length - 20);
  const trailer = data.subarray(data.length - 20);
  return createHash('sha1').update(body).digest().equals(trailer);
}
