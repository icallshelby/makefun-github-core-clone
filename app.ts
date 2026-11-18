// app.ts — HTTP server skeleton, git smart-HTTP routing, and complete REST v3 API implementation

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import type { Store, Repo, Issue, PullRequest, Label, Comment } from './store.ts';
import { FIXED_NOW, nodeId } from './store.ts';
import { VIEWER } from './scenario.ts';
import {
  buildTree,
  parseTree,
  buildCommit,
  parseCommit,
  hashObject,
  isObjectId,
  collectReachable,
} from './gitobj.ts';
import {
  advertiseUploadPackV2,
  advertiseUploadPackV0,
  advertiseReceivePack,
  handleLsRefs,
  handleFetch,
  handleUploadPackV0,
  handleReceivePack,
  parsePktLines,
} from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function sendJson(res: ServerResponse, status: number, data: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper: get file map from tree OID recursively
function getFileMap(repo: Repo, treeOid: string | undefined, prefix = ''): Map<string, { oid: string; size: number; mode: string }> {
  const map = new Map<string, { oid: string; size: number; mode: string }>();
  if (!treeOid) return map;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return map;
  try {
    const entries = parseTree(obj.data);
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        const subMap = getFileMap(repo, entry.oid, fullPath);
        for (const [k, v] of subMap) map.set(k, v);
      } else {
        const blobObj = repo.objects.get(entry.oid);
        const size = blobObj ? blobObj.data.length : 0;
        map.set(fullPath, { oid: entry.oid, size, mode: entry.mode });
      }
    }
  } catch {}
  return map;
}

// Helper: update tree recursively for /contents
function updateTree(
  repo: Repo,
  treeOid: string | undefined,
  segments: string[],
  action: { type: 'put'; blobOid: string; mode?: string } | { type: 'delete' },
): string {
  const entries = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
  const segment = segments[0]!;

  if (segments.length === 1) {
    const filtered = entries.filter(e => e.name !== segment);
    if (action.type === 'put') {
      filtered.push({
        mode: action.mode ?? '100644',
        name: segment,
        oid: action.blobOid,
      });
    }
    const built = buildTree(filtered);
    repo.objects.set(built.oid, { type: 'tree', data: built.data });
    return built.oid;
  } else {
    const rest = segments.slice(1);
    const existing = entries.find(e => e.name === segment);
    const subTreeOid = existing && existing.mode === '40000' ? existing.oid : undefined;
    const newSubOid = updateTree(repo, subTreeOid, rest, action);

    const filtered = entries.filter(e => e.name !== segment);
    filtered.push({
      mode: '40000',
      name: segment,
      oid: newSubOid,
    });
    const built = buildTree(filtered);
    repo.objects.set(built.oid, { type: 'tree', data: built.data });
    return built.oid;
  }
}

function findCommitOid(repo: Repo, refOrSha: string): string | undefined {
  if (repo.refs.has(refOrSha)) return repo.refs.get(refOrSha);
  const asHead = `refs/heads/${refOrSha}`;
  if (repo.refs.has(asHead)) return repo.refs.get(asHead);
  if (isObjectId(refOrSha) && repo.objects.has(refOrSha)) return refOrSha;
  return undefined;
}

function getCommitHistory(repo: Repo, startOid: string): any[] {
  const commits: any[] = [];
  const visited = new Set<string>();
  const queue = [startOid];

  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);

    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;

    try {
      const commit = parseCommit(obj.data);
      commits.push({
        sha: oid,
        node_id: nodeId('Commit', 1),
        commit: {
          author: { name: commit.author.name, email: commit.author.email, date: FIXED_NOW },
          committer: { name: commit.committer.name, email: commit.committer.email, date: FIXED_NOW },
          message: commit.message,
          tree: { sha: commit.tree, url: '' },
          parents: commit.parents.map(p => ({ sha: p, url: '' })),
        },
        author: { login: VIEWER.login, id: VIEWER.id },
        committer: { login: VIEWER.login, id: VIEWER.id },
        parents: commit.parents.map(p => ({ sha: p })),
      });
      for (const parent of commit.parents) {
        if (!visited.has(parent)) queue.push(parent);
      }
    } catch {}
  }
  return commits;
}

function findMergeBase(repo: Repo, baseOid: string, headOid: string): string {
  // 1. Check if base is an ancestor of head
  const headAncestors = new Set<string>();
  const hQueue = [headOid];
  while (hQueue.length > 0) {
    const oid = hQueue.shift()!;
    if (oid === baseOid) return baseOid;
    if (headAncestors.has(oid)) continue;
    headAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      try {
        const parsed = parseCommit(obj.data);
        for (const p of parsed.parents) hQueue.push(p);
      } catch {}
    }
  }

  // 2. Else, common ancestor via parent walk (common ancestors of base and head, excluding baseOid and headOid tips)
  const baseAncestors = new Set<string>();
  const bQueue: string[] = [];
  const baseObj = repo.objects.get(baseOid);
  if (baseObj && baseObj.type === 'commit') {
    try {
      const parsed = parseCommit(baseObj.data);
      for (const p of parsed.parents) bQueue.push(p);
    } catch {}
  }
  while (bQueue.length > 0) {
    const oid = bQueue.shift()!;
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      try {
        const parsed = parseCommit(obj.data);
        for (const p of parsed.parents) bQueue.push(p);
      } catch {}
    }
  }

  const hQueue2: string[] = [];
  const headObj = repo.objects.get(headOid);
  if (headObj && headObj.type === 'commit') {
    try {
      const parsed = parseCommit(headObj.data);
      for (const p of parsed.parents) hQueue2.push(p);
    } catch {}
  }
  const visitedHead = new Set<string>();
  while (hQueue2.length > 0) {
    const oid = hQueue2.shift()!;
    if (baseAncestors.has(oid)) return oid;
    if (visitedHead.has(oid)) continue;
    visitedHead.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      try {
        const parsed = parseCommit(obj.data);
        for (const p of parsed.parents) hQueue2.push(p);
      } catch {}
    }
  }
  return baseOid;
}

export function createApp(store: Store, token: string) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = store.nextRequestId();
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (pathname === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    const authHeader = req.headers.authorization;
    let hasValidAuth = false;
    if (authHeader) {
      if (authHeader === `Bearer ${token}`) {
        hasValidAuth = true;
      } else if (authHeader.startsWith('Basic ')) {
        try {
          const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
          const colon = decoded.indexOf(':');
          const pass = colon >= 0 ? decoded.slice(colon + 1) : decoded;
          if (pass === token) {
            hasValidAuth = true;
          }
        } catch {}
      }
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch) {
      const owner = gitMatch[1]!;
      const repoName = gitMatch[2]!.replace(/\.git$/, '');
      const subPath = gitMatch[3] || '';

      if (owner !== VIEWER.login) {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }

      if (!hasValidAuth) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }

      let repo = store.getRepo(owner, repoName);
      const isInfoRefs = subPath === '/info/refs';
      const isUploadPack = subPath === '/git-upload-pack';
      const isReceivePack = subPath === '/git-receive-pack';

      if (!repo) {
        if (isInfoRefs || isUploadPack || isReceivePack || method === 'GET') {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
      }

      if (isInfoRefs) {
        const service = url.searchParams.get('service');
        const gitProtocol = req.headers['git-protocol'];
        const isV2 = gitProtocol === 'version=2' || (gitProtocol && gitProtocol.includes('version=2'));

        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        if (service === 'git-upload-pack') {
          if (isV2) {
            const buf = advertiseUploadPackV2(repo);
            sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', buf, requestId);
          } else {
            const buf = advertiseUploadPackV0(repo);
            sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', buf, requestId);
          }
          return;
        } else if (service === 'git-receive-pack') {
          const buf = advertiseReceivePack(repo);
          sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', buf, requestId);
          return;
        } else {
          sendJson(res, 400, { message: 'Bad Request: missing or invalid service' }, requestId);
          return;
        }
      }

      if (isUploadPack) {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        try {
          const body = await readBody(req);
          const gitProtocol = req.headers['git-protocol'];
          const isV2 = gitProtocol === 'version=2' || (gitProtocol && gitProtocol.includes('version=2'));

          let respBuf: Buffer;
          if (isV2) {
            const packets = parsePktLines(body);
            const firstData = packets.find(p => p.kind === 'data');
            const firstLine = firstData ? firstData.payload.toString('utf8') : '';
            const isLsRefs = firstLine.includes('command=ls-refs');
            if (isLsRefs) {
              respBuf = handleLsRefs(repo, body);
            } else {
              respBuf = handleFetch(repo, body);
            }
          } else {
            respBuf = handleUploadPackV0(repo, body);
          }
          sendRaw(res, 200, 'application/x-git-upload-pack-result', respBuf, requestId);
        } catch (err: any) {
          sendJson(res, 400, { message: err?.message || 'Bad Request' }, requestId);
        }
        return;
      }

      if (isReceivePack) {
        try {
          if (!repo) {
            repo = store.createRepo(owner, repoName, { defaultBranch: 'main' });
          }
          const body = await readBody(req);
          const respBuf = handleReceivePack(repo, body);
          sendRaw(res, 200, 'application/x-git-receive-pack-result', respBuf, requestId);
        } catch (err: any) {
          sendJson(res, 400, { message: err?.message || 'Bad Request' }, requestId);
        }
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }

    const cleanPath = pathname.replace(/\/$/, '');

    if (cleanPath === '/api/graphql' && method === 'POST') {
      const body = await readBody(req);
      const result = handleGraphql(store, body.toString('utf8'), hasValidAuth);
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    if (cleanPath === '/mcp' && method === 'POST') {
      const body = await readBody(req);
      const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
      const result = handleMcp(store, body.toString('utf8'), hasValidAuth, sessionIdHeader);
      sendJson(res, result.status, result.body, requestId, result.headers);
      return;
    }

    if (pathname.startsWith('/api/v3/')) {
      if (!hasValidAuth) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }

      const apiPath = pathname.slice('/api/v3'.length);

      if (apiPath === '/' || apiPath === '') {
        sendJson(res, 200, {
          current_user_url: `http://${req.headers.host || 'localhost'}/api/v3/user`,
          current_user_authorization_html_url: `http://${req.headers.host || 'localhost'}/settings/connections`,
        }, requestId, { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo' });
        return;
      }

      if (apiPath === '/meta') {
        sendJson(res, 200, { installed_version: '1.0.0' }, requestId);
        return;
      }

      if (apiPath === '/user') {
        sendJson(res, 200, {
          id: VIEWER.id,
          login: VIEWER.login,
          name: VIEWER.name,
          email: VIEWER.email,
        }, requestId);
        return;
      }

      if (apiPath === '/user/repos') {
        if (method === 'GET') {
          const perPage = Number.parseInt(url.searchParams.get('per_page') || '30', 10);
          const page = Number.parseInt(url.searchParams.get('page') || '1', 10);

          const allRepos = [...store.repos.values()].filter(r => r.owner === VIEWER.login);
          const start = (page - 1) * perPage;
          const slice = allRepos.slice(start, start + perPage);

          const host = req.headers.host || 'localhost';
          const protocol = 'http';
          let linkHeader = '';
          if (start + perPage < allRepos.length) {
            linkHeader = `<${protocol}://${host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
          }

          const repoObjects = slice.map(r => ({
            id: r.id,
            name: r.name,
            full_name: r.fullName,
            owner: { login: r.owner, id: VIEWER.id },
            private: r.private,
            description: r.description,
            default_branch: r.defaultBranch,
            html_url: `${protocol}://${host}/${r.fullName}`,
            clone_url: `${protocol}://${host}/${r.fullName}.git`,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
          }));

          const extraHeaders: Record<string, string> = {};
          if (linkHeader) extraHeaders['Link'] = linkHeader;

          sendJson(res, 200, repoObjects, requestId, extraHeaders);
          return;
        }

        if (method === 'POST') {
          let bodyData: any;
          try {
            const raw = await readBody(req);
            bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
            return;
          }

          const name = bodyData.name;
          if (!name || typeof name !== 'string') {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] }, requestId);
            return;
          }

          const description = bodyData.description ?? '';
          const isPrivate = bodyData.private ?? false;
          const defaultBranch = bodyData.default_branch ?? bodyData.defaultBranch ?? 'main';

          const repo = store.createRepo(VIEWER.login, name, {
            description,
            private: isPrivate,
            defaultBranch,
          });

          const host = req.headers.host || 'localhost';
          const protocol = 'http';
          sendJson(res, 201, {
            id: repo.id,
            name: repo.name,
            full_name: repo.fullName,
            owner: { login: repo.owner, id: VIEWER.id },
            private: repo.private,
            description: repo.description,
            default_branch: repo.defaultBranch,
            html_url: `${protocol}://${host}/${repo.fullName}`,
            clone_url: `${protocol}://${host}/${repo.fullName}.git`,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
          }, requestId);
          return;
        }
      }

      // /repos/{o}/{r}/...
      const repoSubMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(apiPath);
      if (repoSubMatch) {
        const owner = repoSubMatch[1]!;
        const repoName = repoSubMatch[2]!;
        const subAction = repoSubMatch[3] || '';

        if (owner !== VIEWER.login) {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        let repo = store.getRepo(owner, repoName);
        if (!repo && (method !== 'GET' || subAction)) {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        const host = req.headers.host || 'localhost';
        const protocol = 'http';

        // 1. Repo base: GET / PATCH / DELETE /repos/{o}/{r}
        if (!subAction) {
          if (method === 'GET') {
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            sendJson(res, 200, {
              id: repo.id,
              name: repo.name,
              full_name: repo.fullName,
              owner: { login: repo.owner, id: VIEWER.id },
              private: repo.private,
              description: repo.description,
              default_branch: repo.defaultBranch,
              html_url: `${protocol}://${host}/${repo.fullName}`,
              clone_url: `${protocol}://${host}/${repo.fullName}.git`,
              created_at: FIXED_NOW,
              updated_at: FIXED_NOW,
            }, requestId);
            return;
          }
          if (method === 'PATCH') {
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            let bodyData: any;
            try {
              const raw = await readBody(req);
              bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
              return;
            }
            if (bodyData.description !== undefined) repo.description = bodyData.description;
            if (bodyData.name !== undefined) repo.name = bodyData.name;
            if (bodyData.private !== undefined) repo.private = bodyData.private;
            repo.fullName = `${repo.owner}/${repo.name}`;

            sendJson(res, 200, {
              id: repo.id,
              name: repo.name,
              full_name: repo.fullName,
              owner: { login: repo.owner, id: VIEWER.id },
              private: repo.private,
              description: repo.description,
              default_branch: repo.defaultBranch,
              html_url: `${protocol}://${host}/${repo.fullName}`,
              clone_url: `${protocol}://${host}/${repo.fullName}.git`,
              created_at: FIXED_NOW,
              updated_at: FIXED_NOW,
            }, requestId);
            return;
          }
          if (method === 'DELETE') {
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            store.repos.delete(`${owner}/${repoName}`);
            res.writeHead(204, { 'X-GitHub-Request-Id': requestId });
            res.end();
            return;
          }
        }

        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // 2. git/refs
        if (subAction === 'git/refs' && method === 'POST') {
          let bodyData: any;
          try {
            const raw = await readBody(req);
            bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
            return;
          }
          const refName = bodyData.ref;
          const sha = bodyData.sha;
          if (!refName || !sha) {
            sendJson(res, 422, { message: 'Validation Failed' }, requestId);
            return;
          }
          repo.refs.set(refName, sha);
          sendJson(res, 201, {
            ref: refName,
            node_id: nodeId('Ref', 1),
            url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/git/refs/${refName}`,
            object: {
              type: 'commit',
              sha,
              url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
            },
          }, requestId);
          return;
        }

        // 3. branches
        if (subAction === 'branches' && method === 'GET') {
          const branches: any[] = [];
          for (const [refName, oid] of repo.refs) {
            if (refName.startsWith('refs/heads/')) {
              const name = refName.slice('refs/heads/'.length);
              branches.push({
                name,
                commit: {
                  sha: oid,
                  url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/commits/${oid}`,
                },
                protected: false,
              });
            }
          }
          sendJson(res, 200, branches, requestId);
          return;
        }

        // 4. commits
        if (subAction === 'commits' && method === 'GET') {
          const shaParam = url.searchParams.get('sha') || repo.defaultBranch;
          const startOid = findCommitOid(repo, shaParam);
          if (!startOid) {
            sendJson(res, 200, [], requestId);
            return;
          }
          const history = getCommitHistory(repo, startOid);
          sendJson(res, 200, history, requestId);
          return;
        }

        // 5. contents/{path}
        const contentsMatch = /^contents\/(.+)$/.exec(subAction);
        if (contentsMatch) {
          const filePath = contentsMatch[1]!;
          const refParam = url.searchParams.get('ref') || repo.defaultBranch;
          const commitOid = findCommitOid(repo, refParam);

          if (method === 'GET') {
            if (!commitOid) {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            const commitObj = repo.objects.get(commitOid);
            if (!commitObj || commitObj.type !== 'commit') {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            const commitParsed = parseCommit(commitObj.data);
            const fileMap = getFileMap(repo, commitParsed.tree);

            const segments = filePath.split('/').filter(Boolean);
            const fileInfo = fileMap.get(filePath);
            if (fileInfo) {
              const blobObj = repo.objects.get(fileInfo.oid);
              const contentBuf = blobObj ? blobObj.data : Buffer.alloc(0);
              sendJson(res, 200, {
                name: segments[segments.length - 1],
                path: filePath,
                sha: fileInfo.oid,
                size: contentBuf.length,
                url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/contents/${filePath}`,
                html_url: `${protocol}://${host}/${repo.fullName}/blob/${refParam}/${filePath}`,
                git_url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/git/blobs/${fileInfo.oid}`,
                download_url: `${protocol}://${host}/raw/${repo.fullName}/${refParam}/${filePath}`,
                type: 'file',
                encoding: 'base64',
                content: contentBuf.toString('base64'),
                _links: {
                  self: `${protocol}://${host}/api/v3/repos/${repo.fullName}/contents/${filePath}`,
                  git: `${protocol}://${host}/api/v3/repos/${repo.fullName}/git/blobs/${fileInfo.oid}`,
                  html: `${protocol}://${host}/${repo.fullName}/blob/${refParam}/${filePath}`,
                },
              }, requestId);
              return;
            }

            const entries: any[] = [];
            const subTreeOid = (() => {
              let currTreeOid = commitParsed.tree;
              for (const seg of segments) {
                const trObj = repo.objects.get(currTreeOid);
                if (!trObj || trObj.type !== 'tree') return undefined;
                const entriesList = parseTree(trObj.data);
                const found = entriesList.find(e => e.name === seg);
                if (!found) return undefined;
                currTreeOid = found.oid;
              }
              return currTreeOid;
            })();

            if (subTreeOid) {
              const trObj = repo.objects.get(subTreeOid);
              if (trObj && trObj.type === 'tree') {
                const list = parseTree(trObj.data);
                for (const item of list) {
                  const itemPath = `${filePath}/${item.name}`;
                  const isDir = item.mode === '40000';
                  entries.push({
                    name: item.name,
                    path: itemPath,
                    sha: item.oid,
                    size: isDir ? 0 : (repo.objects.get(item.oid)?.data.length || 0),
                    url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/contents/${itemPath}`,
                    type: isDir ? 'dir' : 'file',
                  });
                }
                sendJson(res, 200, entries, requestId);
                return;
              }
            }

            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }

          if (method === 'PUT' || method === 'DELETE') {
            let bodyData: any;
            try {
              const raw = await readBody(req);
              bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
              return;
            }

            const branch = bodyData.branch || repo.defaultBranch;
            const branchRef = `refs/heads/${branch}`;
            const currentTip = repo.refs.get(branchRef);
            let currentTreeOid: string | undefined;
            const parentOids: string[] = [];

            if (currentTip) {
              parentOids.push(currentTip);
              const tipObj = repo.objects.get(currentTip);
              if (tipObj && tipObj.type === 'commit') {
                try {
                  currentTreeOid = parseCommit(tipObj.data).tree;
                } catch {}
              }
            }

            const fileMap = getFileMap(repo, currentTreeOid);
            const existingFile = fileMap.get(filePath);

            if (method === 'PUT') {
              const message = bodyData.message || 'Update file';
              const contentBase64 = bodyData.content || '';
              const expectedSha = bodyData.sha;

              if (existingFile) {
                if (expectedSha && expectedSha !== existingFile.oid) {
                  sendJson(res, 409, { message: 'Sha mismatch / Stale file' }, requestId);
                  return;
                }
              }

              const blobData = Buffer.from(contentBase64.replace(/\n/g, ''), 'base64');
              const blobOid = hashObject('blob', blobData);
              repo.objects.set(blobOid, { type: 'blob', data: blobData });

              const segments = filePath.split('/').filter(Boolean);
              const newTreeOid = updateTree(repo, currentTreeOid, segments, { type: 'put', blobOid });

              const author = { name: VIEWER.name, email: VIEWER.email, epoch: 1735689600, tz: '+0000' };
              const committer = author;
              const commitBuild = buildCommit({
                tree: newTreeOid,
                parents: parentOids,
                author,
                committer,
                message,
              });
              repo.objects.set(commitBuild.oid, { type: 'commit', data: commitBuild.data });
              repo.refs.set(branchRef, commitBuild.oid);

              const isCreate = !existingFile;
              const status = isCreate ? 201 : 200;

              sendJson(res, status, {
                content: {
                  name: segments[segments.length - 1],
                  path: filePath,
                  sha: blobOid,
                  size: blobData.length,
                  url: `${protocol}://${host}/api/v3/repos/${repo.fullName}/contents/${filePath}`,
                  type: 'file',
                  encoding: 'base64',
                },
                commit: {
                  sha: commitBuild.oid,
                  message,
                  tree: { sha: newTreeOid },
                  parents: parentOids.map(p => ({ sha: p })),
                },
              }, requestId);
              return;
            }

            if (method === 'DELETE') {
              if (!existingFile) {
                sendJson(res, 404, { message: 'Not Found' }, requestId);
                return;
              }
              const message = bodyData.message || 'Delete file';
              const expectedSha = bodyData.sha;
              if (expectedSha && expectedSha !== existingFile.oid) {
                sendJson(res, 409, { message: 'Sha mismatch' }, requestId);
                return;
              }

              const segments = filePath.split('/').filter(Boolean);
              const newTreeOid = updateTree(repo, currentTreeOid, segments, { type: 'delete' });

              const author = { name: VIEWER.name, email: VIEWER.email, epoch: 1735689600, tz: '+0000' };
              const committer = author;
              const commitBuild = buildCommit({
                tree: newTreeOid,
                parents: parentOids,
                author,
                committer,
                message,
              });
              repo.objects.set(commitBuild.oid, { type: 'commit', data: commitBuild.data });
              repo.refs.set(branchRef, commitBuild.oid);

              sendJson(res, 200, {
                commit: {
                  sha: commitBuild.oid,
                  message,
                  tree: { sha: newTreeOid },
                  parents: parentOids.map(p => ({ sha: p })),
                },
              }, requestId);
              return;
            }
          }
        }

        // 6. labels
        if (subAction === 'labels' && method === 'POST') {
          let bodyData: any;
          try {
            const raw = await readBody(req);
            bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
            return;
          }
          const name = bodyData.name;
          const color = bodyData.color || 'ededed';
          if (!name) {
            sendJson(res, 422, { message: 'Validation Failed' }, requestId);
            return;
          }
          const labelObj: Label = {
            id: repo.labels.size + 1,
            nodeId: nodeId('Label', repo.labels.size + 1),
            name,
            color,
            description: bodyData.description || '',
          };
          repo.labels.set(name, labelObj);
          sendJson(res, 201, {
            id: labelObj.id,
            node_id: labelObj.nodeId,
            name: labelObj.name,
            color: labelObj.color,
            description: labelObj.description,
            default: false,
          }, requestId);
          return;
        }

        // 7. issues
        if (subAction === 'issues' && method === 'GET') {
          const stateParam = url.searchParams.get('state') || 'open';
          const sortParam = url.searchParams.get('sort') || 'created';
          const directionParam = url.searchParams.get('direction') || 'asc';

          const issuesList = [...repo.issues.values()].filter(i => {
            if (stateParam === 'all') return true;
            return i.state === stateParam;
          });

          issuesList.sort((a, b) => {
            const cmp = a.seq - b.seq;
            return directionParam === 'desc' ? -cmp : cmp;
          });

          const formatted = issuesList.map(i => ({
            id: i.id,
            node_id: i.nodeId,
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
            labels: i.labels.map(lName => {
              const l = repo.labels.get(lName);
              return { id: l?.id ?? 1, name: lName, color: l?.color ?? 'ededed' };
            }),
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: i.createdAt,
            updated_at: i.updatedAt,
            comments: i.comments.length,
            html_url: `${protocol}://${host}/${repo.fullName}/issues/${i.number}`,
          }));

          sendJson(res, 200, formatted, requestId);
          return;
        }

        if (subAction === 'issues' && method === 'POST') {
          let bodyData: any;
          try {
            const raw = await readBody(req);
            bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
            return;
          }
          const title = bodyData.title;
          if (!title) {
            sendJson(res, 422, { message: 'Validation Failed: title missing' }, requestId);
            return;
          }
          const labelNames: string[] = bodyData.labels || [];
          for (const lName of labelNames) {
            if (!repo.labels.has(lName)) {
              sendJson(res, 422, { message: `Label ${lName} does not exist` }, requestId);
              return;
            }
          }

          const number = repo.nextIssue++;
          const issueObj: Issue = {
            id: repo.id * 1000 + number,
            nodeId: nodeId('Issue', number),
            number,
            title,
            body: bodyData.body || '',
            state: 'open',
            labels: labelNames,
            seq: number,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
            comments: [],
          };
          repo.issues.set(number, issueObj);

          sendJson(res, 201, {
            id: issueObj.id,
            node_id: issueObj.nodeId,
            number: issueObj.number,
            title: issueObj.title,
            body: issueObj.body,
            state: issueObj.state,
            labels: labelNames.map(lName => {
              const l = repo.labels.get(lName);
              return { id: l?.id ?? 1, name: lName, color: l?.color ?? 'ededed' };
            }),
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: issueObj.createdAt,
            updated_at: issueObj.updatedAt,
            html_url: `${protocol}://${host}/${repo.fullName}/issues/${number}`,
          }, requestId);
          return;
        }

        // /issues/{n} or /issues/{n}/comments
        const issueMatch = /^issues\/(\d+)(?:\/(.*))?$/.exec(subAction);
        if (issueMatch) {
          const issueNum = Number.parseInt(issueMatch[1]!, 10);
          const issueSub = issueMatch[2] || '';
          const issue = repo.issues.get(issueNum);

          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }

          if (!issueSub) {
            if (method === 'GET') {
              sendJson(res, 200, {
                id: issue.id,
                node_id: issue.nodeId,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: issue.labels.map(lName => {
                  const l = repo.labels.get(lName);
                  return { id: l?.id ?? 1, name: lName, color: l?.color ?? 'ededed' };
                }),
                user: { login: VIEWER.login, id: VIEWER.id },
                created_at: issue.createdAt,
                updated_at: issue.updatedAt,
                html_url: `${protocol}://${host}/${repo.fullName}/issues/${issue.number}`,
              }, requestId);
              return;
            }
            if (method === 'PATCH') {
              let bodyData: any;
              try {
                const raw = await readBody(req);
                bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
              } catch {
                sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
                return;
              }
              if (bodyData.state !== undefined) issue.state = bodyData.state;
              if (bodyData.title !== undefined) issue.title = bodyData.title;
              if (bodyData.body !== undefined) issue.body = bodyData.body;
              issue.updatedAt = FIXED_NOW;

              sendJson(res, 200, {
                id: issue.id,
                node_id: issue.nodeId,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: issue.labels.map(lName => {
                  const l = repo.labels.get(lName);
                  return { id: l?.id ?? 1, name: lName, color: l?.color ?? 'ededed' };
                }),
                user: { login: VIEWER.login, id: VIEWER.id },
                created_at: issue.createdAt,
                updated_at: issue.updatedAt,
                html_url: `${protocol}://${host}/${repo.fullName}/issues/${issue.number}`,
              }, requestId);
              return;
            }
          }

          if (issueSub === 'comments') {
            if (method === 'GET') {
              const formattedComments = issue.comments.map(c => ({
                id: c.id,
                node_id: c.nodeId,
                body: c.body,
                user: { login: VIEWER.login, id: VIEWER.id },
                created_at: c.createdAt,
                updated_at: c.createdAt,
                html_url: `${protocol}://${host}/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
              }));
              sendJson(res, 200, formattedComments, requestId);
              return;
            }
            if (method === 'POST') {
              let bodyData: any;
              try {
                const raw = await readBody(req);
                bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
              } catch {
                sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
                return;
              }
              const commentBody = bodyData.body || '';
              const commentId = issue.comments.length + 100;
              const commentObj: Comment = {
                id: commentId,
                nodeId: nodeId('Comment', commentId),
                body: commentBody,
                seq: issue.comments.length + 1,
                createdAt: FIXED_NOW,
              };
              issue.comments.push(commentObj);

              sendJson(res, 201, {
                id: commentObj.id,
                node_id: commentObj.nodeId,
                body: commentObj.body,
                user: { login: VIEWER.login, id: VIEWER.id },
                created_at: commentObj.createdAt,
                updated_at: commentObj.createdAt,
                html_url: `${protocol}://${host}/${repo.fullName}/issues/${issue.number}#issuecomment-${commentObj.id}`,
              }, requestId);
              return;
            }
          }
        }

        // 8. pulls
        if (subAction === 'pulls' && method === 'GET') {
          const stateParam = url.searchParams.get('state') || 'open';
          const pullsList = [...repo.pulls.values()].filter(p => {
            if (stateParam === 'all') return true;
            return p.state === stateParam;
          });

          pullsList.sort((a, b) => a.seq - b.seq);

          const formatted = pullsList.map(p => ({
            id: p.id,
            node_id: p.nodeId,
            number: p.number,
            state: p.state,
            title: p.title,
            body: p.body,
            merged: p.merged,
            head: { ref: p.head, sha: p.headSha, repo: { full_name: repo.fullName } },
            base: { ref: p.base, sha: p.baseSha, repo: { full_name: repo.fullName } },
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: p.createdAt,
            merged_at: p.mergedAt,
            merge_commit_sha: p.mergeCommitSha,
            html_url: `${protocol}://${host}/${repo.fullName}/pull/${p.number}`,
          }));

          sendJson(res, 200, formatted, requestId);
          return;
        }

        if (subAction === 'pulls' && method === 'POST') {
          let bodyData: any;
          try {
            const raw = await readBody(req);
            bodyData = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
            return;
          }

          const title = bodyData.title;
          const headRefName = bodyData.head;
          const baseRefName = bodyData.base;

          if (!title || !headRefName || !baseRefName) {
            sendJson(res, 422, { message: 'Validation Failed: missing fields' }, requestId);
            return;
          }

          const headSha = findCommitOid(repo, headRefName);
          const baseSha = findCommitOid(repo, baseRefName);

          if (!headSha || !baseSha) {
            sendJson(res, 422, { message: 'Head or base branch not found' }, requestId);
            return;
          }

          const number = repo.nextIssue++; // shared sequence with issues
          const pullObj: PullRequest = {
            id: repo.id * 2000 + number,
            nodeId: nodeId('PullRequest', number),
            number,
            title,
            body: bodyData.body || '',
            state: 'open',
            merged: false,
            head: headRefName,
            base: baseRefName,
            headSha,
            baseSha,
            mergeCommitSha: null,
            mergedAt: null,
            seq: number,
            createdAt: FIXED_NOW,
          };
          repo.pulls.set(number, pullObj);

          sendJson(res, 201, {
            id: pullObj.id,
            node_id: pullObj.nodeId,
            number: pullObj.number,
            state: pullObj.state,
            title: pullObj.title,
            body: pullObj.body,
            merged: pullObj.merged,
            head: { ref: pullObj.head, sha: pullObj.headSha, repo: { full_name: repo.fullName } },
            base: { ref: pullObj.base, sha: pullObj.baseSha, repo: { full_name: repo.fullName } },
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: pullObj.createdAt,
            merged_at: pullObj.mergedAt,
            merge_commit_sha: pullObj.mergeCommitSha,
            html_url: `${protocol}://${host}/${repo.fullName}/pull/${number}`,
          }, requestId);
          return;
        }

        // pulls/{n} or pulls/{n}/files or pulls/{n}/merge
        const pullMatch = /^pulls\/(\d+)(?:\/(.*))?$/.exec(subAction);
        if (pullMatch) {
          const pullNum = Number.parseInt(pullMatch[1]!, 10);
          const pullSub = pullMatch[2] || '';
          const pull = repo.pulls.get(pullNum);

          if (!pull) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }

          if (!pullSub) {
            if (method === 'GET') {
              sendJson(res, 200, {
                id: pull.id,
                node_id: pull.nodeId,
                number: pull.number,
                state: pull.state,
                title: pull.title,
                body: pull.body,
                merged: pull.merged,
                head: { ref: pull.head, sha: pull.headSha, repo: { full_name: repo.fullName } },
                base: { ref: pull.base, sha: pull.baseSha, repo: { full_name: repo.fullName } },
                user: { login: VIEWER.login, id: VIEWER.id },
                created_at: pull.createdAt,
                merged_at: pull.mergedAt,
                merge_commit_sha: pull.mergeCommitSha,
                html_url: `${protocol}://${host}/${repo.fullName}/pull/${pull.number}`,
              }, requestId);
              return;
            }
          }

          if (pullSub === 'files' && method === 'GET') {
            const baseCommitObj = repo.objects.get(pull.baseSha);
            const headCommitObj = repo.objects.get(pull.headSha);
            const baseTreeOid = baseCommitObj && baseCommitObj.type === 'commit' ? parseCommit(baseCommitObj.data).tree : undefined;
            const headTreeOid = headCommitObj && headCommitObj.type === 'commit' ? parseCommit(headCommitObj.data).tree : undefined;

            const baseMap = getFileMap(repo, baseTreeOid);
            const headMap = getFileMap(repo, headTreeOid);

            const allPaths = new Set([...baseMap.keys(), ...headMap.keys()]);
            const filesList: any[] = [];

            for (const path of allPaths) {
              const inBase = baseMap.get(path);
              const inHead = headMap.get(path);

              if (!inBase && inHead) {
                const blob = repo.objects.get(inHead.oid);
                const text = blob ? blob.data.toString('utf8') : '';
                const linesCount = text ? text.split('\n').length : 1;
                filesList.push({
                  filename: path,
                  status: 'added',
                  additions: linesCount,
                  deletions: 0,
                  changes: linesCount,
                });
              } else if (inBase && !inHead) {
                const blob = repo.objects.get(inBase.oid);
                const text = blob ? blob.data.toString('utf8') : '';
                const linesCount = text ? text.split('\n').length : 1;
                filesList.push({
                  filename: path,
                  status: 'removed',
                  additions: 0,
                  deletions: linesCount,
                  changes: linesCount,
                });
              } else if (inBase && inHead && inBase.oid !== inHead.oid) {
                const baseBlob = repo.objects.get(inBase.oid);
                const headBlob = repo.objects.get(inHead.oid);
                const baseText = baseBlob ? baseBlob.data.toString('utf8') : '';
                const headText = headBlob ? headBlob.data.toString('utf8') : '';
                const baseLines = baseText ? baseText.split('\n').length : 1;
                const headLines = headText ? headText.split('\n').length : 1;
                filesList.push({
                  filename: path,
                  status: 'modified',
                  additions: headLines,
                  deletions: baseLines,
                  changes: headLines + baseLines,
                });
              }
            }
            sendJson(res, 200, filesList, requestId);
            return;
          }

          if (pullSub === 'merge' && method === 'PUT') {
            const defaultRef = `refs/heads/${repo.defaultBranch}`;
            const defaultTip = repo.refs.get(defaultRef) || pull.baseSha;

            const baseCommitObj = repo.objects.get(defaultTip);
            const headCommitObj = repo.objects.get(pull.headSha);
            const baseTreeOid = baseCommitObj && baseCommitObj.type === 'commit' ? parseCommit(baseCommitObj.data).tree : undefined;
            const headTreeOid = headCommitObj && headCommitObj.type === 'commit' ? parseCommit(headCommitObj.data).tree : undefined;

            const mbOid = findMergeBase(repo, defaultTip, pull.headSha);
            const mbCommitObj = repo.objects.get(mbOid);
            const mbTreeOid = mbCommitObj && mbCommitObj.type === 'commit' ? parseCommit(mbCommitObj.data).tree : undefined;

            const baseMap = getFileMap(repo, baseTreeOid);
            const headMap = getFileMap(repo, headTreeOid);
            const mbMap = getFileMap(repo, mbTreeOid);

            let hasConflict = false;
            const allPaths = new Set([...baseMap.keys(), ...headMap.keys(), ...mbMap.keys()]);

            for (const path of allPaths) {
              const baseBlob = baseMap.get(path)?.oid;
              const headBlob = headMap.get(path)?.oid;
              const mbBlob = mbMap.get(path)?.oid;

              const baseModified = baseBlob !== mbBlob;
              const headModified = headBlob !== mbBlob;

              if (baseModified && headModified && baseBlob !== headBlob) {
                hasConflict = true;
                break;
              }
            }

            if (hasConflict) {
              sendJson(res, 405, { message: 'Pull request has merge conflicts' }, requestId);
              return;
            }

            const author = { name: VIEWER.name, email: VIEWER.email, epoch: 1735689600, tz: '+0000' };
            const committer = author;
            const mergeMessage = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;

            const commitBuild = buildCommit({
              tree: headTreeOid!,
              parents: [defaultTip],
              author,
              committer,
              message: mergeMessage,
            });

            repo.objects.set(commitBuild.oid, { type: 'commit', data: commitBuild.data });
            repo.refs.set(defaultRef, commitBuild.oid);

            pull.state = 'closed';
            pull.merged = true;
            pull.mergedAt = FIXED_NOW;
            pull.mergeCommitSha = commitBuild.oid;

            sendJson(res, 200, {
              sha: commitBuild.oid,
              merged: true,
              message: 'Pull Request successfully merged',
            }, requestId);
            return;
          }
        }
      }

      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  });
}
