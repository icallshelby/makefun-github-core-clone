// store.ts — The shared in-memory store every later surface reads and writes

import { VIEWER } from './scenario.ts';

export const FIXED_NOW = '2026-01-01T00:00:00Z';

export function nodeId(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`, 'utf8').toString('base64url');
}

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  seq: number;
  createdAt: string;
}

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
  createdAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  seq: number;
}

export class Store {
  repos: Map<string, Repo> = new Map();
  nextRepoId: number = 5000;
  requestSeq: number = 0;
  viewerLogin: string = VIEWER.login;
  private globalSeq: number = 0;

  createRepo(
    owner: string,
    name: string,
    opts: {
      description?: string;
      private?: boolean;
      defaultBranch?: string;
      id?: number;
    } = {},
  ): Repo {
    const fullName = `${owner}/${name}`;
    const id = opts.id ?? this.nextRepoId++;
    const repo: Repo = {
      id,
      owner,
      name,
      fullName,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      seq: ++this.globalSeq,
    };
    this.repos.set(fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  nextRequestId(): string {
    return `req-${++this.requestSeq}`;
  }
}
