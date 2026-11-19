// gitproto.ts — Git smart HTTP protocol implementation (v2 upload-pack, v0 upload-pack, v0 receive-pack)

import { Buffer } from 'node:buffer';
import type { Repo, GitObject } from './store.ts';
import {
  GitProtocolError,
  asBuffer,
  sha1,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  collectReachable,
} from './gitobj.ts';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new GitProtocolError(`pkt-line payload is ${data.length} bytes, over max`, 'pktline-too-long');
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodeSideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  const maxPayload = PKT_LINE_MAX_PAYLOAD - 1; // 1 byte for band indicator
  const chunks: Buffer[] = [];
  let offset = 0;
  if (data.length === 0) {
    const pkt = Buffer.allocUnsafe(5);
    pkt.write('0005', 0, 4, 'ascii');
    pkt[4] = band;
    chunks.push(pkt);
  } else {
    while (offset < data.length) {
      const take = Math.min(maxPayload, data.length - offset);
      const chunk = data.subarray(offset, offset + take);
      const pkt = Buffer.allocUnsafe(5 + take);
      pkt.write((take + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
      pkt[4] = band;
      chunk.copy(pkt, 5);
      chunks.push(pkt);
      offset += take;
    }
  }
  return Buffer.concat(chunks);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

export function parsePktLines(buf: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  const view = asBuffer(buf);
  while (offset < view.length) {
    if (offset + 4 > view.length) {
      throw new GitProtocolError('truncated pkt-line header', 'pktline-truncated');
    }
    const headerStr = view.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(headerStr)) {
      throw new GitProtocolError(`invalid pkt-line header ${JSON.stringify(headerStr)}`, 'pktline-header');
    }
    const len = Number.parseInt(headerStr, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > view.length) {
      throw new GitProtocolError(`invalid pkt-line length ${len}`, 'pktline-length');
    }
    const raw = view.subarray(offset, offset + len);
    const payload = view.subarray(offset + 4, offset + len);
    packets.push({ kind: 'data', payload, raw });
    offset += len;
  }
  return packets;
}

export function parseSideband(buf: Buffer): { band: number; data: Buffer }[] {
  const packets = parsePktLines(buf);
  const result: { band: number; data: Buffer }[] = [];
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    if (pkt.payload.length < 1) continue;
    const band = pkt.payload[0]!;
    const data = Buffer.from(pkt.payload.subarray(1));
    result.push({ band, data });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Ref helpers & ls-refs
// ---------------------------------------------------------------------------------------------

function getDefaultBranchTip(repo: Repo): string {
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  if (tip) return tip;
  for (const [refName, oid] of repo.refs) {
    if (refName.startsWith('refs/heads/')) return oid;
  }
  return '';
}

export interface RefEntry {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

export function lsRefs(
  repo: Repo,
  args: { prefixes?: readonly string[]; peel?: boolean; symrefs?: boolean; unborn?: boolean } = {},
): RefEntry[] {
  const prefixes = args.prefixes ?? [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some(p => name.startsWith(p));

  const result: RefEntry[] = [];
  const hasRefs = repo.refs.size > 0;

  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef) || getDefaultBranchTip(repo);

  if (keep('HEAD')) {
    if (!hasRefs && args.unborn) {
      result.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef });
    } else if (defaultTip) {
      result.push({ oid: defaultTip, name: 'HEAD', symrefTarget: defaultRef });
    } else if (args.unborn) {
      result.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef });
    }
  }

  const sortedRefs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [refName, oid] of sortedRefs) {
    if (!keep(refName)) continue;
    let peeled: string | undefined;
    if (args.peel !== false) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        try {
          const tag = parseTag(obj.data);
          peeled = tag.object;
        } catch {}
      }
    }
    result.push({ oid, name: refName, peeled });
  }

  // No synthetic unborn fallback (git native does not advertise unborn refs for empty repos)
  return result;
}

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = parsePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }

  const entries = lsRefs(repo, { prefixes, peel, symrefs, unborn });
  const outLines: Array<string | 'flush' | 'delim'> = [];

  for (const entry of entries) {
    let lineStr = '';
    if (entry.unborn || entry.oid === ZERO_OID) {
      lineStr = `unborn ${entry.name}`;
      if (entry.symrefTarget) lineStr += ` symref-target:${entry.symrefTarget}`;
    } else {
      lineStr = `${entry.oid} ${entry.name}`;
      if (entry.symrefTarget && symrefs) lineStr += ` symref-target:${entry.symrefTarget}`;
      if (entry.peeled && peel) lineStr += ` peeled:${entry.peeled}`;
    }
    outLines.push(`${lineStr}\n`);
  }
  outLines.push('flush');

  const encoded: Buffer[] = [];
  for (const item of outLines) {
    if (item === 'flush') encoded.push(encodeFlush());
    else if (item === 'delim') encoded.push(encodeDelim());
    else encoded.push(encodePktLine(item));
  }
  return Buffer.concat(encoded);
}

// ---------------------------------------------------------------------------------------------
// Upload Pack V2 (Fetch)
// ---------------------------------------------------------------------------------------------

function collectTreeObjects(objects: Map<string, GitObject>, treeOid: string, result: Set<string>): void {
  if (result.has(treeOid)) return;
  const obj = objects.get(treeOid);
  if (!obj) return;
  result.add(treeOid);
  if (obj.type === 'tree') {
    try {
      const entries = parseTree(obj.data);
      for (const entry of entries) {
        collectTreeObjects(objects, entry.oid, result);
      }
    } catch {}
  }
}

export function advertiseUploadPackV2(repo: Repo): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn symref ref-prefix\n',
    'fetch=shallow deepen-since deepen-not deepen-relative filter\n',
    'object-format=sha1\n',
    'agent=makefun-git-server/1.0\n',
    'flush',
  ];
  const encoded: Buffer[] = [];
  for (const l of lines) {
    if (l === 'flush') encoded.push(encodeFlush());
    else encoded.push(encodePktLine(l));
  }
  return Buffer.concat(encoded);
}

export function handleFetch(repo: Repo, body: Buffer): Buffer {
  const packets = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const requestShallows = new Set<string>();
  let depth: number | undefined;
  let filter: string | undefined;

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) requestShallows.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
  }

  let reachableFromWants: Set<string>;
  const boundaryCommits = new Set<string>();

  if (depth !== undefined) {
    const includedCommits = new Set<string>();
    const queue: { oid: string; dist: number }[] = [];
    const visitedDist = new Map<string, number>();

    reachableFromWants = new Set<string>();

    for (const wantOid of wants) {
      let curr: string | undefined = wantOid;
      const seenTags = new Set<string>();

      while (curr !== undefined) {
        const obj = repo.objects.get(curr);
        reachableFromWants.add(curr);

        if (obj?.type !== 'tag') break;
        if (seenTags.has(curr)) {
          curr = undefined;
          break;
        }
        seenTags.add(curr);

        try {
          curr = parseTag(obj.data).object;
        } catch {
          curr = undefined;
        }
      }

      if (curr === undefined) continue;

      const obj = repo.objects.get(curr);
      if (obj?.type === 'commit') {
        if (!visitedDist.has(curr)) {
          visitedDist.set(curr, 0);
          queue.push({ oid: curr, dist: 0 });
        }
      } else if (obj) {
        for (const oid of collectReachable(repo.objects, [curr])) {
          reachableFromWants.add(oid);
        }
      }
    }

    for (let i = 0; i < queue.length; i++) {
      const { oid, dist } = queue[i]!;
      if (dist >= depth) continue;

      const obj = repo.objects.get(oid);
      if (obj?.type !== 'commit') continue;

      includedCommits.add(oid);
      reachableFromWants.add(oid);

      try {
        const commit = parseCommit(obj.data);

        for (const treeOid of collectReachable(repo.objects, [commit.tree])) {
          reachableFromWants.add(treeOid);
        }

        const nextDist = dist + 1;
        if (nextDist < depth) {
          for (const parent of commit.parents) {
            const previousDist = visitedDist.get(parent);
            if (previousDist === undefined || previousDist > nextDist) {
              visitedDist.set(parent, nextDist);
              queue.push({ oid: parent, dist: nextDist });
            }
          }
        }
      } catch {}
    }

    for (const oid of includedCommits) {
      const obj = repo.objects.get(oid);
      if (obj?.type !== 'commit') continue;

      try {
        const commit = parseCommit(obj.data);
        if (commit.parents.some(parent => !includedCommits.has(parent))) {
          boundaryCommits.add(oid);
        }
      } catch {}
    }
  } else {
    reachableFromWants = collectReachable(repo.objects, wants);
  }

  const reachableFromHaves = new Set<string>();
  const haveQueue = [...haves];

  for (let i = 0; i < haveQueue.length; i++) {
    const oid = haveQueue[i]!;
    if (reachableFromHaves.has(oid)) continue;
    reachableFromHaves.add(oid);

    const obj = repo.objects.get(oid);
    if (!obj) continue;

    if (obj.type === 'commit') {
      try {
        const commit = parseCommit(obj.data);

        for (const treeOid of collectReachable(repo.objects, [commit.tree])) {
          reachableFromHaves.add(treeOid);
        }

        if (!requestShallows.has(oid)) {
          haveQueue.push(...commit.parents);
        }
      } catch {}
    } else if (obj.type === 'tag') {
      try {
        haveQueue.push(parseTag(obj.data).object);
      } catch {}
    } else if (obj.type === 'tree') {
      for (const treeOid of collectReachable(repo.objects, [oid])) {
        reachableFromHaves.add(treeOid);
      }
    }
  }

  const unshallowCommits = new Set<string>();

  for (const oid of requestShallows) {
    if (!reachableFromWants.has(oid) || boundaryCommits.has(oid)) continue;

    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;

    try {
      const commit = parseCommit(obj.data);
      if (
        commit.parents.every(
          parent =>
            reachableFromWants.has(parent) || reachableFromHaves.has(parent),
        )
      ) {
        unshallowCommits.add(oid);
      }
    } catch {}
  }

  const objectIds = [...reachableFromWants].filter(
    oid => !reachableFromHaves.has(oid),
  );

  const objectsToSend: {
    type: 'commit' | 'tree' | 'blob' | 'tag';
    data: Buffer;
  }[] = [];

  for (const oid of objectIds) {
    const obj = repo.objects.get(oid);
    if (obj) objectsToSend.push(obj);
  }

  const packBuffer = writePack(objectsToSend);
  const sidebandPack = encodeSideband(1, packBuffer);

  const sections: Buffer[] = [];

  if (haves.length > 0) {
    sections.push(encodePktLine('acknowledgments\n'));
    for (const have of haves) {
      if (repo.objects.has(have) || reachableFromWants.has(have)) {
        sections.push(encodePktLine(`ACK ${have}\n`));
      }
    }
    sections.push(encodeFlush());
  }

  if (depth !== undefined || unshallowCommits.size > 0) {
    sections.push(encodePktLine('shallow-info\n'));
    for (const oid of boundaryCommits) {
      if (!requestShallows.has(oid)) {
        sections.push(encodePktLine(`shallow ${oid}\n`));
      }
    }
    for (const oid of unshallowCommits) {
      sections.push(encodePktLine(`unshallow ${oid}\n`));
    }
    sections.push(encodeFlush());
  }

  sections.push(encodePktLine('packfile\n'));
  sections.push(sidebandPack);
  sections.push(encodeFlush());

  return Buffer.concat(sections);
}

// ---------------------------------------------------------------------------------------------
// Upload Pack V0
// ---------------------------------------------------------------------------------------------

export function advertiseUploadPackV0(repo: Repo): Buffer {
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef) || getDefaultBranchTip(repo);

  const caps = 'side-band-64k multi_ack_detailed no-progress include-tag ofs-delta agent=makefun-git-server/1.0';

  let first = true;
  const sortedRefs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  
  const headTip = repo.refs.get('HEAD') || defaultTip;
  if (headTip) {
    const line = first ? `${headTip} HEAD\u0000${caps}\n` : `${headTip} HEAD\n`;
    lines.push(line);
    first = false;
  }

  for (const [refName, oid] of sortedRefs) {
    const line = first ? `${oid} ${refName}\u0000${caps}\n` : `${oid} ${refName}\n`;
    lines.push(line);
    first = false;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      try {
        const tag = parseTag(obj.data);
        lines.push(`${tag.object} ${refName}^{}\n`);
      } catch {}
    }
  }

  if (first) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  }

  const encoded: Buffer[] = [];
  encoded.push(encodePktLine('# service=git-upload-pack\n'));
  encoded.push(encodeFlush());
  for (const l of lines) encoded.push(encodePktLine(l));
  encoded.push(encodeFlush());
  return Buffer.concat(encoded);
}

export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }

  const reachableFromWants = collectReachable(repo.objects, wants);
  const reachableFromHaves = collectReachable(repo.objects, haves);
  const objectIds = [...reachableFromWants].filter(oid => !reachableFromHaves.has(oid));

  const objectsToSend: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[] = [];
  for (const oid of objectIds) {
    const obj = repo.objects.get(oid);
    if (obj) objectsToSend.push(obj);
  }

  const packBuffer = writePack(objectsToSend);
  const sidebandPack = encodeSideband(1, packBuffer);

  const nakPkt = encodePktLine('NAK\n');
  return Buffer.concat([nakPkt, sidebandPack, encodeFlush()]);
}

// ---------------------------------------------------------------------------------------------
// Receive Pack V0 (Push)
// ---------------------------------------------------------------------------------------------

export function advertiseReceivePack(repo: Repo): Buffer {
  const lines: string[] = [];
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta object-format=sha1 agent=makefun-git-server/1.0';

  let first = true;
  const sortedRefs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [refName, oid] of sortedRefs) {
    const line = first ? `${oid} ${refName}\u0000${caps}\n` : `${oid} ${refName}\n`;
    lines.push(line);
    first = false;
  }

  if (first) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  }

  const encoded: Buffer[] = [];
  encoded.push(encodePktLine('# service=git-receive-pack\n'));
  encoded.push(encodeFlush());
  for (const l of lines) encoded.push(encodePktLine(l));
  encoded.push(encodeFlush());
  return Buffer.concat(encoded);
}

interface PushCommandItem {
  oldOid: string;
  newOid: string;
  refName: string;
}

function isDescendantWithTempObjects(objects: Map<string, GitObject>, ancestorOid: string, descendantOid: string): boolean {
  if (ancestorOid === ZERO_OID) return true;
  if (ancestorOid === descendantOid) return true;
  const reachable = collectReachable(objects, [descendantOid]);
  return reachable.has(ancestorOid);
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const view = asBuffer(body);
  const packets: GitPacket[] = [];
  let offset = 0;

  while (offset < view.length) {
    if (offset + 4 > view.length) break;
    const headerStr = view.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(headerStr)) break;
    const len = Number.parseInt(headerStr, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > view.length) break;
    const raw = view.subarray(offset, offset + len);
    const payload = view.subarray(offset + 4, offset + len);
    packets.push({ kind: 'data', payload, raw });
    offset += len;
  }

  const commands: PushCommandItem[] = [];
  let firstCmd = true;

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (firstCmd) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) line = line.slice(0, nul);
      firstCmd = false;
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      const oldOid = parts[0]!;
      const newOid = parts[1]!;
      const refName = parts.slice(2).join(' ');
      commands.push({ oldOid, newOid, refName });
    }
  }

  const packBytes = view.subarray(offset);

  const tempObjects = new Map<string, GitObject>(repo.objects);
  let unpackError: string | undefined;

  if (packBytes.length > 32) {
    try {
      const unpacked = readPack(packBytes, {
        resolveBase: (oid) => tempObjects.get(oid),
      });
      for (const obj of unpacked) {
        tempObjects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  const acceptedCommands: PushCommandItem[] = [];

  if (unpackError) {
    for (const cmd of commands) {
      results.push({ ref: cmd.refName, ok: false, reason: `pack-error: ${unpackError}` });
    }
  } else {
    for (const cmd of commands) {
      const currentOid = repo.refs.get(cmd.refName) || ZERO_OID;
      if (cmd.oldOid !== currentOid && cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.refName, ok: false, reason: 'stale-info' });
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        acceptedCommands.push(cmd);
        results.push({ ref: cmd.refName, ok: true });
        continue;
      }
      if (currentOid !== ZERO_OID && cmd.oldOid !== ZERO_OID) {
        if (!isDescendantWithTempObjects(tempObjects, currentOid, cmd.newOid)) {
          results.push({ ref: cmd.refName, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      acceptedCommands.push(cmd);
      results.push({ ref: cmd.refName, ok: true });
    }
  }

  if (acceptedCommands.length > 0) {
    for (const [oid, obj] of tempObjects) {
      repo.objects.set(oid, obj);
    }
    for (const cmd of acceptedCommands) {
      const res = results.find(r => r.ref === cmd.refName);
      if (!res || !res.ok) continue;
      if (cmd.newOid === ZERO_OID) {
        repo.refs.delete(cmd.refName);
      } else {
        repo.refs.set(cmd.refName, cmd.newOid);
      }
    }
  }

  const reportParts: Buffer[] = [encodePktLine('unpack ok\n')];
  for (const res of results) {
    reportParts.push(
      encodePktLine(
        res.ok
          ? `ok ${res.ref}\n`
          : `ng ${res.ref} ${res.reason ?? 'failed'}\n`,
      ),
    );
  }
  reportParts.push(encodeFlush());
  const reportBuffer = Buffer.concat(reportParts);

  return Buffer.concat([
    encodeSideband(1, reportBuffer),
    encodeFlush(),
  ]);
}
