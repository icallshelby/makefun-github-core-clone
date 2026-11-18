// gitobj.ts — Git object model + packfiles (byte-compatible with kit's git-client.ts)

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { GitObject } from './store.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export class GitProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code = 'protocol') {
    super(message);
    this.name = 'GitProtocolError';
    this.code = code;
  }
}

export function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function sha1(data: Uint8Array): string {
  return createHash('sha1').update(asBuffer(data)).digest('hex');
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function encodeObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  return sha1(encodeObject(type, data));
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): { oid: string; data: Buffer } {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitProtocolError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  const oid = hashObject('tree', data);
  return { oid, data };
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitProtocolError('tree entry has no mode separator', 'tree-parse');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitProtocolError('tree entry has no name terminator', 'tree-parse');
    if (nul + 21 > buffer.length) throw new GitProtocolError('tree entry has a truncated object id', 'tree-parse');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitProtocolError(`tree entry mode ${JSON.stringify(mode)} is not octal`, 'tree-parse');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitFields {
  tree: string;
  parents?: readonly string[];
  author: { name: string; email: string; epoch: number; tz: string };
  committer: { name: string; email: string; epoch: number; tz: string };
  message: string;
}

export function buildCommit(fields: CommitFields): { oid: string; data: Buffer } {
  if (!isObjectId(fields.tree)) throw new GitProtocolError('buildCommit needs a valid tree id', 'commit-build');
  const authorLine = `${fields.author.name} <${fields.author.email}> ${fields.author.epoch} ${fields.author.tz}`;
  const committerLine = `${fields.committer.name} <${fields.committer.email}> ${fields.committer.epoch} ${fields.committer.tz}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new GitProtocolError('buildCommit needs valid parent ids', 'commit-build');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  const data = Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
  const oid = hashObject('commit', data);
  return { oid, data };
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: { name: string; email: string; epoch: number; tz: string };
  committer: { name: string; email: string; epoch: number; tz: string };
  message: string;
}

function parseSignature(line: string): { name: string; email: string; epoch: number; tz: string } {
  const match = /^(.*)\s+<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(line);
  if (!match) {
    return { name: line, email: '', epoch: 0, tz: '+0000' };
  }
  return {
    name: match[1]!,
    email: match[2]!,
    epoch: Number.parseInt(match[3]!, 10),
    tz: match[4]!,
  };
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', epoch: 0, tz: '+0000' };
  let committer = { name: '', email: '', epoch: 0, tz: '+0000' };
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = parseSignature(value);
    else if (key === 'committer') committer = parseSignature(value);
  }
  if (!isObjectId(tree)) throw new GitProtocolError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) if (!isObjectId(parent)) throw new GitProtocolError('commit has a bad parent id', 'commit-parse');
  return { tree, parents, author, committer, message };
}

export interface TagFields {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: { name: string; email: string; epoch: number; tz: string };
  message: string;
}

export function buildTag(fields: TagFields): { oid: string; data: Buffer } {
  if (!isObjectId(fields.object)) throw new GitProtocolError('buildTag needs a valid object id', 'tag-build');
  const taggerLine = `${fields.tagger.name} <${fields.tagger.email}> ${fields.tagger.epoch} ${fields.tagger.tz}`;
  const data = Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${taggerLine}\n\n${fields.message}`,
    'utf8',
  );
  const oid = hashObject('tag', data);
  return { oid, data };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: { name: string; email: string; epoch: number; tz: string };
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitProtocolError(`tag header ${JSON.stringify(line)} has no value`, 'tag-parse');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = (headers.get('type') ?? '') as GitObjectType;
  if (!isObjectId(object)) throw new GitProtocolError('tag has no valid object header', 'tag-parse');
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: parseSignature(headers.get('tagger') ?? ''),
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

// Packfile reading & writing
const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitProtocolError('pack entry has no size header', 'pack-truncated');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitProtocolError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitProtocolError('pack entry size varint is too long', 'pack-corrupt');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitProtocolError('ofs-delta has no base offset', 'pack-truncated');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitProtocolError('ofs-delta base offset is truncated', 'pack-truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitProtocolError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitProtocolError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new GitProtocolError('delta size varint is truncated', 'delta-corrupt');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitProtocolError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new GitProtocolError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = deltaBuffer[offset++]!;
      if (op & 0x02) copyOffset += deltaBuffer[offset++]! * 256;
      if (op & 0x04) copyOffset += deltaBuffer[offset++]! * 65536;
      if (op & 0x08) copyOffset += deltaBuffer[offset++]! * 16777216;
      if (op & 0x10) copySize = deltaBuffer[offset++]!;
      if (op & 0x20) copySize += deltaBuffer[offset++]! * 256;
      if (op & 0x40) copySize += deltaBuffer[offset++]! * 65536;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new GitProtocolError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new GitProtocolError('delta writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new GitProtocolError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new GitProtocolError('delta writes past its target size', 'delta-corrupt');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitProtocolError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new GitProtocolError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

export function packChecksum(pack: Uint8Array): string {
  const buffer = asBuffer(pack);
  if (buffer.length < 20) throw new GitProtocolError('pack is shorter than its trailer', 'pack-truncated');
  return sha1(buffer.subarray(0, buffer.length - 20));
}

export function readPack(pack: Uint8Array, options: { resolveBase?: (oid: string) => { type: GitObjectType; data: Buffer } | undefined } = {}): { oid: string; type: GitObjectType; data: Buffer }[] {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new GitProtocolError(`pack is ${buffer.length} bytes, too short`, 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new GitProtocolError('pack does not start with PACK', 'pack-header');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitProtocolError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = sha1(buffer.subarray(0, trailerStart));
  if (trailer !== computedTrailer) {
    throw new GitProtocolError('pack checksum mismatch', 'pack-checksum');
  }

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new GitProtocolError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`, 'pack-delta');
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitProtocolError('ref-delta base id is truncated', 'pack-truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitProtocolError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new GitProtocolError(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
        'pack-size',
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new GitProtocolError(`pack has ${trailerStart - offset} stray bytes before its trailer`, 'pack-trailing');
  }

  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitProtocolError(`delta cycle at pack offset ${entry.offset}`, 'pack-delta-cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new GitProtocolError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`, 'pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new GitProtocolError(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`, 'pack-delta-base');
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  const results: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  for (const entry of raw) {
    const resolved = resolve(entry);
    results.push({ oid: resolved.oid, type: resolved.type, data: resolved.data });
  }
  return results;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code! << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }> | ReadonlyArray<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const list = [...objects].map(obj => ({
    type: obj.type,
    data: asBuffer(obj.data),
    oid: hashObject(obj.type, obj.data),
  })).sort((a, b) => a.oid.localeCompare(b.oid));

  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);

  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

export function collectReachable(objects: Map<string, GitObject>, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of tips) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      const entries = parseTree(object.data);
      for (const entry of entries) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      queue.push(tag.object);
    }
  }
  return seen;
}
