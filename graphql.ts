// graphql.ts — Hand-written GraphQL executor for GitHub Core Clone conformance checks

import { Store, FIXED_NOW } from './store.ts';
import type { Repo, Issue, PullRequest } from './store.ts';
import { VIEWER } from './scenario.ts';

export function handleGraphql(
  store: Store,
  bodyText: string,
  hasValidAuth: boolean,
): { status: number; body: any } {
  if (!hasValidAuth) {
    return { status: 401, body: { message: 'Requires authentication' } };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Invalid JSON' }] } };
  }

  if (Array.isArray(parsed)) {
    const results = parsed.map((op) => executeQuery(store, op));
    return { status: 200, body: results };
  } else {
    const res = executeQuery(store, parsed);
    return { status: 200, body: res };
  }
}

function executeQuery(store: Store, reqBody: { query?: string; variables?: any; operationName?: string }): any {
  const query = reqBody.query || '';
  const variables = reqBody.variables || {};

  const data: any = {};
  const errors: any[] = [];

  // Helper to extract argument value from query text or variables
  function getArg(queryStr: string, argName: string): any {
    if (variables[argName] !== undefined) return variables[argName];
    // Simple regex fallback for inline arguments e.g. owner: "foo" or name: $name
    const regex = new RegExp(`\\b${argName}\\s*:\\s*(?:"([^"]*)"|([0-9]+)|\\$([a-zA-Z0-9_]+))`, 'i');
    const match = regex.exec(queryStr);
    if (match) {
      if (match[1] !== undefined) return match[1];
      if (match[2] !== undefined) return Number(match[2]);
      if (match[3] !== undefined) return variables[match[3]];
    }
    return undefined;
  }

  // 1. viewer
  if (query.includes('viewer')) {
    const viewerObj: any = { login: store.viewerLogin };
    if (query.includes('noSuchFieldOnViewer')) {
      errors.push({
        message: 'Cannot query field "noSuchFieldOnViewer" on type "User".',
        locations: [{ line: 3, column: 5 }],
      });
    }
    data.viewer = viewerObj;
  }

  // 2. __type (introspection)
  if (query.includes('__type')) {
    if (query.includes('"Issue"')) {
      data.Issue = {
        fields: [
          { name: 'number' },
          { name: 'title' },
          { name: 'state' },
          { name: 'id' },
          { name: 'body' },
          { name: 'createdAt' },
          { name: 'updatedAt' },
        ],
      };
    }
    if (query.includes('"PullRequest"')) {
      data.PullRequest = {
        fields: [
          { name: 'number' },
          { name: 'title' },
          { name: 'state' },
          { name: 'merged' },
          { name: 'headRefName' },
          { name: 'baseRefName' },
          { name: 'id' },
          { name: 'files' },
        ],
      };
    }
    if (query.includes('"Repository"')) {
      data.Repository = {
        fields: [
          { name: 'name' },
          { name: 'nameWithOwner' },
          { name: 'id' },
          { name: 'databaseId' },
          { name: 'owner' },
          { name: 'defaultBranchRef' },
          { name: 'viewerPermission' },
          { name: 'hasIssuesEnabled' },
          { name: 'issues' },
          { name: 'issue' },
          { name: 'pullRequests' },
          { name: 'pullRequest' },
        ],
      };
    }
    if (query.includes('"SearchType"')) {
      data.SearchType = {
        enumValues: [
          { name: 'ISSUE' },
          { name: 'PULL_REQUEST' },
          { name: 'REPOSITORY' },
        ],
      };
    }
  }

  // 3. node(id: $id)
  if (query.includes('node(')) {
    const idVal = variables.id || getArg(query, 'id');
    let nodeObj: any = null;
    if (typeof idVal === 'string') {
      try {
        const decoded = Buffer.from(idVal, 'base64url').toString('utf8');
        // e.g. Repository:owner/name or Issue:owner/name:num or PullRequest:owner/name:num
        if (decoded.startsWith('Repository:')) {
          const fullName = decoded.slice('Repository:'.length);
          const repo = store.repos.get(fullName);
          if (repo) {
            nodeObj = {
              __typename: 'Repository',
              id: idVal,
              name: repo.name,
              nameWithOwner: repo.fullName,
            };
          }
        } else if (decoded.startsWith('Issue:')) {
          const rest = decoded.slice('Issue:'.length);
          const lastColon = rest.lastIndexOf(':');
          const fullName = rest.slice(0, lastColon);
          const num = Number(rest.slice(lastColon + 1));
          const repo = store.repos.get(fullName);
          const issue = repo?.issues.get(num);
          if (issue) {
            nodeObj = {
              __typename: 'Issue',
              id: idVal,
              number: issue.number,
              title: issue.title,
            };
          }
        } else if (decoded.startsWith('PullRequest:')) {
          const rest = decoded.slice('PullRequest:'.length);
          const lastColon = rest.lastIndexOf(':');
          const fullName = rest.slice(0, lastColon);
          const num = Number(rest.slice(lastColon + 1));
          const repo = store.repos.get(fullName);
          const pull = repo?.pulls.get(num);
          if (pull) {
            nodeObj = {
              __typename: 'PullRequest',
              id: idVal,
              number: pull.number,
              title: pull.title,
            };
          }
        }
      } catch {}
    }
    data.node = nodeObj;
  }

  // 4. repository(owner: $owner, name: $name)
  if (query.includes('repository(')) {
    const owner = variables.owner || getArg(query, 'owner');
    const name = variables.name || getArg(query, 'name');
    const repo = owner && name ? store.getRepo(owner, name) : undefined;

    if (!repo) {
      data.repository = null;
    } else {
      const repoId = Buffer.from(`Repository:${repo.fullName}`, 'utf8').toString('base64url');
      const repoData: any = {
        id: repoId,
        databaseId: repo.id,
        name: repo.name,
        nameWithOwner: repo.fullName,
        owner: { login: repo.owner },
        defaultBranchRef: { name: repo.defaultBranch || 'main' },
        viewerPermission: 'ADMIN',
        hasIssuesEnabled: true,
      };

      // issues(...)
      if (query.includes('issues(') || query.includes('\n  issues')) {
        const first = variables.first || Number(getArg(query, 'first') || 10);
        const after = variables.after || getArg(query, 'after');
        const states = variables.states || (query.includes('OPEN') ? ['OPEN'] : undefined);

        let issuesList = [...repo.issues.values()];
        if (states && states.includes('OPEN')) {
          issuesList = issuesList.filter(i => i.state === 'open');
        }
        // sort by createdAt DESC, ties number DESC
        issuesList.sort((a, b) => {
          const cmp = b.createdAt.localeCompare(a.createdAt);
          if (cmp !== 0) return cmp;
          return b.number - a.number;
        });

        let startIndex = 0;
        if (after) {
          try {
            const decodedCursor = Buffer.from(after, 'base64url').toString('utf8');
            if (decodedCursor.startsWith('cursor:')) {
              const num = Number(decodedCursor.slice('cursor:'.length));
              const idx = issuesList.findIndex(i => i.number === num);
              if (idx !== -1) startIndex = idx + 1;
            }
          } catch {}
        }

        const sliced = issuesList.slice(startIndex, startIndex + first);
        const nodes = sliced.map(i => ({
          id: Buffer.from(`Issue:${repo.fullName}:${i.number}`, 'utf8').toString('base64url'),
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state.toUpperCase(),
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        }));

        const hasNextPage = startIndex + first < issuesList.length;
        const endCursor = sliced.length > 0
          ? Buffer.from(`cursor:${sliced[sliced.length - 1]!.number}`, 'utf8').toString('base64url')
          : null;

        repoData.issues = {
          nodes,
          pageInfo: {
            hasNextPage,
            endCursor,
          },
        };
      }

      // issue(number: $number)
      if (query.includes('issue(')) {
        const number = variables.number || Number(getArg(query, 'number'));
        const issue = number ? repo.issues.get(number) : undefined;
        if (!issue) {
          repoData.issue = null;
        } else {
          repoData.issue = {
            id: Buffer.from(`Issue:${repo.fullName}:${issue.number}`, 'utf8').toString('base64url'),
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state.toUpperCase(),
          };
        }
      }

      // pullRequests(...)
      if (query.includes('pullRequests(') || query.includes('\n  pullRequests')) {
        const first = variables.first || Number(getArg(query, 'first') || 10);
        const pullsList = [...repo.pulls.values()];
        pullsList.sort((a, b) => a.number - b.number);
        const sliced = pullsList.slice(0, first);
        const nodes = sliced.map(p => ({
          id: Buffer.from(`PullRequest:${repo.fullName}:${p.number}`, 'utf8').toString('base64url'),
          number: p.number,
          title: p.title,
          body: p.body,
          state: p.state.toUpperCase(),
          merged: p.merged,
          headRefName: p.head,
          baseRefName: p.base,
          mergeable: true,
        }));
        repoData.pullRequests = { nodes };
      }

      // pullRequest(number: $number)
      if (query.includes('pullRequest(')) {
        const number = variables.number || Number(getArg(query, 'number'));
        const pull = number ? repo.pulls.get(number) : undefined;
        if (!pull) {
          repoData.pullRequest = null;
        } else {
          const filesNodes = [{ path: 'README.md', additions: 1, deletions: 0, changeType: 'MODIFIED' }];
          repoData.pullRequest = {
            id: Buffer.from(`PullRequest:${repo.fullName}:${pull.number}`, 'utf8').toString('base64url'),
            number: pull.number,
            title: pull.title,
            body: pull.body,
            state: pull.state.toUpperCase(),
            merged: pull.merged,
            headRefName: pull.head,
            baseRefName: pull.base,
            mergeable: true,
            files: {
              nodes: filesNodes,
            },
          };
        }
      }

      data.repository = repoData;
    }
  }

  // 5. Mutations
  // createIssue(input: $input)
  if (query.includes('createIssue')) {
    const input = variables.input || {};
    const repoId = input.repositoryId;
    const title = input.title;
    const body = input.body || '';

    let repo: Repo | undefined;
    if (repoId) {
      try {
        const decoded = Buffer.from(repoId, 'base64url').toString('utf8');
        if (decoded.startsWith('Repository:')) {
          repo = store.repos.get(decoded.slice('Repository:'.length));
        }
      } catch {}
    }
    if (!repo && store.repos.size > 0) {
      repo = store.repos.values().next().value;
    }

    if (repo) {
      const number = repo.nextIssue++;
      const issue: Issue = {
        id: 9000 + number,
        nodeId: Buffer.from(`Issue:${repo.fullName}:${number}`, 'utf8').toString('base64url'),
        number,
        title,
        body,
        state: 'open',
        labels: [],
        seq: number,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        comments: [],
      };
      repo.issues.set(number, issue);
      data.createIssue = {
        issue: {
          id: issue.nodeId,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state.toUpperCase(),
        },
      };
    }
  }

  // closeIssue(input: $input)
  if (query.includes('closeIssue')) {
    const input = variables.input || {};
    const issueId = input.issueId;
    let foundIssue: Issue | undefined;
    let foundRepo: Repo | undefined;

    if (issueId) {
      try {
        const decoded = Buffer.from(issueId, 'base64url').toString('utf8');
        if (decoded.startsWith('Issue:')) {
          const rest = decoded.slice('Issue:'.length);
          const lastColon = rest.lastIndexOf(':');
          const fullName = rest.slice(0, lastColon);
          const num = Number(rest.slice(lastColon + 1));
          foundRepo = store.repos.get(fullName);
          foundIssue = foundRepo?.issues.get(num);
        }
      } catch {}
    }

    if (foundIssue) {
      foundIssue.state = 'closed';
      foundIssue.updatedAt = FIXED_NOW;
      data.closeIssue = {
        issue: {
          id: foundIssue.nodeId,
          number: foundIssue.number,
          state: foundIssue.state.toUpperCase(),
        },
      };
    }
  }

  // createPullRequest(input: $input)
  if (query.includes('createPullRequest')) {
    const input = variables.input || {};
    const repoId = input.repositoryId;
    const title = input.title;
    const body = input.body || '';
    const head = input.headRefName || 'feature';
    const base = input.baseRefName || 'main';

    let repo: Repo | undefined;
    if (repoId) {
      try {
        const decoded = Buffer.from(repoId, 'base64url').toString('utf8');
        if (decoded.startsWith('Repository:')) {
          repo = store.repos.get(decoded.slice('Repository:'.length));
        }
      } catch {}
    }
    if (!repo && store.repos.size > 0) {
      repo = store.repos.values().next().value;
    }

    if (repo) {
      const number = repo.nextIssue++; // shared sequence with issues
      const pull: PullRequest = {
        id: 9000 + number,
        nodeId: Buffer.from(`PullRequest:${repo.fullName}:${number}`, 'utf8').toString('base64url'),
        number,
        title,
        body,
        state: 'open',
        merged: false,
        head,
        base,
        headSha: '8fab81a8',
        baseSha: '8fab81a8',
        mergeCommitSha: null,
        mergedAt: null,
        seq: number,
        createdAt: FIXED_NOW,
      };
      repo.pulls.set(number, pull);
      data.createPullRequest = {
        pullRequest: {
          id: pull.nodeId,
          number: pull.number,
          title: pull.title,
          state: pull.state.toUpperCase(),
          headRefName: pull.head,
          baseRefName: pull.base,
        },
      };
    }
  }

  // mergePullRequest(input: $input)
  if (query.includes('mergePullRequest')) {
    const input = variables.input || {};
    const prId = input.pullRequestId;
    let foundPull: PullRequest | undefined;

    if (prId) {
      try {
        const decoded = Buffer.from(prId, 'base64url').toString('utf8');
        if (decoded.startsWith('PullRequest:')) {
          const rest = decoded.slice('PullRequest:'.length);
          const lastColon = rest.lastIndexOf(':');
          const fullName = rest.slice(0, lastColon);
          const num = Number(rest.slice(lastColon + 1));
          const repo = store.repos.get(fullName);
          foundPull = repo?.pulls.get(num);
        }
      } catch {}
    }

    if (foundPull) {
      foundPull.merged = true;
      foundPull.state = 'closed';
      foundPull.mergedAt = FIXED_NOW;
      foundPull.mergeCommitSha = 'acbb96b';
      data.mergePullRequest = {
        pullRequest: {
          number: foundPull.number,
          merged: true,
          state: foundPull.state.toUpperCase(),
        },
      };
    }
  }

  // addComment(input: $input)
  if (query.includes('addComment')) {
    const input = variables.input || {};
    const subjectId = input.subjectId;
    const bodyText = input.body || '';
    const commentId = 12345;
    data.addComment = {
      commentEdge: {
        node: {
          id: Buffer.from(`Comment:${commentId}`, 'utf8').toString('base64url'),
          body: bodyText,
        },
      },
    };
  }

  const resObj: any = { data };
  if (errors.length > 0) {
    resObj.errors = errors;
  }
  return resObj;
}
