// mcp.ts — Model Context Protocol (MCP) Streamable HTTP endpoint implementation

import { Store, FIXED_NOW } from './store.ts';
import type { Repo, Issue, PullRequest } from './store.ts';
import { VIEWER } from './scenario.ts';

const TOOLS_LIST = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Private repository' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository details',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'PR title' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
        body: { type: 'string', description: 'PR body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// Serialized once byte-for-byte identical
const SERIALIZED_TOOLS_LIST = JSON.stringify(TOOLS_LIST);

export function handleMcp(
  store: Store,
  bodyText: string,
  hasValidAuth: boolean,
  sessionIdHeader?: string,
): { status: number; headers: Record<string, string>; body: any } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (sessionIdHeader) {
    headers['Mcp-Session-Id'] = sessionIdHeader;
  }

  if (!hasValidAuth) {
    return { status: 401, headers, body: { message: 'Requires authentication' } };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      headers,
      body: {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: invalid JSON' },
        id: null,
      },
    };
  }

  const id = parsed.id !== undefined ? parsed.id : null;
  const method = parsed.method;
  const params = parsed.params || {};

  if (method === 'server/discover') {
    return {
      status: 200,
      headers,
      body: {
        jsonrpc: '2.0',
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
        },
        id,
      },
    };
  }

  if (method === 'initialize') {
    const protoVer = params.protocolVersion || '2025-11-25';
    return {
      status: 200,
      headers,
      body: {
        jsonrpc: '2.0',
        result: {
          protocolVersion: protoVer,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'github-core-clone',
            version: '1.0.0',
          },
        },
        id,
      },
    };
  }

  if (method === 'notifications/initialized') {
    return {
      status: 202,
      headers,
      body: '',
    };
  }

  if (method === 'tools/list') {
    // Return byte-identical JSON-parsed tools list
    return {
      status: 200,
      headers,
      body: {
        jsonrpc: '2.0',
        result: {
          tools: JSON.parse(SERIALIZED_TOOLS_LIST),
        },
        id,
      },
    };
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};

    const foundTool = TOOLS_LIST.find((t) => t.name === toolName || t.name === toolName.toLowerCase());
    if (!foundTool) {
      return {
        status: 200,
        headers,
        body: {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
          id,
        },
      };
    }

    try {
      const resultObj = executeTool(store, foundTool.name, args);
      return {
        status: 200,
        headers,
        body: {
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(resultObj),
              },
            ],
            isError: false,
          },
          id,
        },
      };
    } catch (err: any) {
      return {
        status: 200,
        headers,
        body: {
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: err.message }),
              },
            ],
            isError: true,
          },
          id,
        },
      };
    }
  }

  return {
    status: 200,
    headers,
    body: {
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${method}` },
      id,
    },
  };
}

function executeTool(store: Store, name: string, args: any): any {
  const owner = args.owner || VIEWER.login;
  const repoName = args.repo || args.repository || args.name;

  if (name === 'create_repo') {
    const rName = args.name;
    if (!rName) throw new Error('Missing required argument: name');
    const repo = store.createRepo(owner, rName, {
      description: args.description || '',
      private: args.private || false,
    });
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
  }

  if (name === 'get_repo') {
    if (!owner || !repoName) throw new Error('Missing required arguments: owner, repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
  }

  if (name === 'create_issue') {
    if (!owner || !repoName || !args.title) throw new Error('Missing required arguments: owner, repo, title');
    const repo = store.getRepo(owner, repoName) || store.createRepo(owner, repoName);
    const number = repo.nextIssue++;
    const issue: Issue = {
      id: 9000 + number,
      nodeId: Buffer.from(`Issue:${repo.fullName}:${number}`, 'utf8').toString('base64url'),
      number,
      title: args.title,
      body: args.body || '',
      state: 'open',
      labels: [],
      seq: number,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      comments: [],
    };
    repo.issues.set(number, issue);
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
    };
  }

  if (name === 'list_issues') {
    if (!owner || !repoName) throw new Error('Missing required arguments: owner, repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return [];
    const issues = [...repo.issues.values()].map(i => ({
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
    }));
    return issues;
  }

  if (name === 'create_pull_request') {
    if (!owner || !repoName || !args.title || !args.head || !args.base) {
      throw new Error('Missing required arguments: owner, repo, title, head, base');
    }
    const repo = store.getRepo(owner, repoName) || store.createRepo(owner, repoName);
    const number = repo.nextIssue++; // shared sequence
    const pull: PullRequest = {
      id: 9000 + number,
      nodeId: Buffer.from(`PullRequest:${repo.fullName}:${number}`, 'utf8').toString('base64url'),
      number,
      title: args.title,
      body: args.body || '',
      state: 'open',
      merged: false,
      head: args.head,
      base: args.base,
      headSha: '8fab81a8',
      baseSha: '8fab81a8',
      mergeCommitSha: null,
      mergedAt: null,
      seq: number,
      createdAt: FIXED_NOW,
    };
    repo.pulls.set(number, pull);
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      head: { ref: pull.head },
      base: { ref: pull.base },
      merged: pull.merged,
    };
  }

  if (name === 'merge_pull_request') {
    const pullNum = args.pull_number ?? args.pullNumber ?? args.pull_request_number;
    if (!owner || !repoName || pullNum === undefined) {
      throw new Error('Missing required arguments: owner, repo, pull_number');
    }
    const repo = store.getRepo(owner, repoName);
    const pull = repo?.pulls.get(Number(pullNum));
    if (!pull) throw new Error(`Pull request not found: #${pullNum}`);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = FIXED_NOW;
    pull.mergeCommitSha = 'acbb96b';
    return {
      number: pull.number,
      merged: true,
      message: 'Pull Request successfully merged',
      state: pull.state,
    };
  }

  throw new Error(`Unknown tool action: ${name}`);
}
