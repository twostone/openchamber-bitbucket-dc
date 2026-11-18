import type { SourceControlForge } from '@openchamber/sdk';
import { CallError } from './types.js';

export class BB {
  constructor(
    readonly ctx: string,
    readonly handle: string,
    readonly forge: SourceControlForge,
  ) {}

  rest(path: string): string {
    return `${this.ctx}/rest/api/latest${path}`;
  }
}

export type BBResponse = { status: number; headers: Record<string, string>; body: string };

export async function bbDo(
  bb: BB,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
): Promise<BBResponse> {
  let res;
  try {
    res = await bb.forge.request(bb.handle, {
      method,
      path,
      query: opts.query,
      headers: opts.headers,
      body: opts.body,
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      const e = err as Error & { code?: string };
      const code = e.code && /^[A-Z_]{1,64}$/.test(e.code) ? e.code : 'FORGE_UNREACHABLE';
      throw new CallError(`Outbound proxy refused the request: ${e.message}`, code);
    }
    throw new CallError(
      `Outbound request failed: ${err instanceof Error ? err.message : String(err)}`,
      'FORGE_UNREACHABLE',
    );
  }
  return { status: res.status, headers: res.headers, body: res.body };
}

export async function bbGetJson<T = unknown>(
  bb: BB,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const res = await bbDo(bb, 'GET', path, { query, headers: { accept: 'application/json' } });
  return expectJson<T>(res);
}

export async function bbPostJson<T = unknown>(
  bb: BB,
  path: string,
  body: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const res = await bbDo(bb, 'POST', path, {
    query,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return expectJson<T>(res);
}

export async function bbPutJson<T = unknown>(
  bb: BB,
  path: string,
  body: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const res = await bbDo(bb, 'PUT', path, {
    query,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return expectJson<T>(res);
}

export async function bbDelete(bb: BB, path: string, query?: Record<string, string>): Promise<number> {
  const res = await bbDo(bb, 'DELETE', path, { query, headers: { accept: 'application/json' } });
  if (res.status >= 200 && res.status < 300) return res.status;
  throw httpError(res);
}

export function httpError(res: BBResponse): CallError {
  const json = parseJsonLoose(res.body);
  let apiMsg: string | null = null;
  if (json && typeof json === 'object') {
    const obj = json as { errors?: Array<{ message?: unknown }>; message?: unknown };
    const firstErr = Array.isArray(obj.errors) ? obj.errors.find((e) => typeof e?.message === 'string') : undefined;
    if (firstErr && typeof firstErr.message === 'string') apiMsg = firstErr.message;
    else if (typeof obj.message === 'string') apiMsg = obj.message;
  }
  const msg = apiMsg || `Bitbucket answered HTTP ${res.status}`;
  switch (res.status) {
    case 400:
      return new CallError(msg, 'BAD_REQUEST', 400);
    case 401:
      return new CallError(msg, 'UNAUTHORIZED', 401);
    case 403:
      return new CallError(msg, 'FORBIDDEN', 403);
    case 404:
      return new CallError(msg, 'NOT_FOUND', 404);
    case 409:
      return new CallError(msg, 'CONFLICT', 409);
    case 422:
      return new CallError(msg, 'UNPROCESSABLE', 422);
    default:
      return new CallError(msg, 'FORGE_ERROR', res.status >= 400 && res.status <= 599 ? res.status : 502);
  }
}

function expectJson<T>(res: BBResponse): T {
  if (res.status >= 200 && res.status < 300) {
    if (!res.body) return {} as T;
    const json = parseJsonLoose(res.body);
    if (json === null) throw new CallError('Bitbucket returned malformed JSON.', 'MALFORMED_JSON', 502);
    return json as T;
  }
  throw httpError(res);
}

export function parseJsonLoose(body: string): unknown | null {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bitbucket Data Center 10.5 REST API schemas (`10.5.swagger.v3.json`)
// ---------------------------------------------------------------------------

export type BbUser = {
  id?: number;
  slug?: string;
  name?: string;
  displayName?: string;
  emailAddress?: string;
  avatarUrl?: string;
  type?: 'NORMAL' | 'SERVICE' | string;
  active?: boolean;
  links?: { self?: Array<{ href?: string }> };
};

export type BbProject = {
  id?: number;
  key: string;
  name?: string;
  type?: 'NORMAL' | 'PERSONAL' | string;
  links?: { self?: Array<{ href?: string }> };
};

export type BbRepo = {
  id: number;
  slug: string;
  name: string;
  state?: string;
  project: BbProject;
  /** Fork upstream repository (`RestRepository.origin` in Bitbucket DC 10.5). */
  origin?: BbRepo | null;
  links?: {
    self?: Array<{ href?: string }>;
    clone?: Array<{ name?: string; href?: string }>;
  };
};

export type BbRef = {
  id?: string;
  displayId?: string;
  latestCommit?: string;
  type?: 'BRANCH' | 'TAG' | string;
  repository?: BbRepo;
};

export type BbParticipant = {
  user?: BbUser;
  role?: 'AUTHOR' | 'REVIEWER' | 'PARTICIPANT' | 'CREATOR' | string;
  approved?: boolean;
  status?: 'UNAPPROVED' | 'NEEDS_WORK' | 'APPROVED' | string;
  lastReviewedCommit?: string;
};

export type BbPullRequest = {
  id: number;
  version: number;
  title?: string;
  description?: string;
  state?: 'OPEN' | 'DECLINED' | 'MERGED' | string;
  open?: boolean;
  closed?: boolean;
  draft?: boolean;
  locked?: boolean;
  createdDate?: number;
  updatedDate?: number;
  closedDate?: number;
  fromRef?: BbRef;
  toRef?: BbRef;
  author?: BbParticipant;
  participants?: BbParticipant[];
  reviewers?: BbParticipant[];
  properties?: {
    openTaskCount?: number;
    resolvedTaskCount?: number;
    commentCount?: number;
    mergeResult?: { outcome?: string; current?: boolean };
  } & Record<string, unknown>;
  links?: { self?: Array<{ href?: string }> };
};

export type BbPage<T> = {
  size?: number;
  limit?: number;
  start?: number;
  isLastPage?: boolean;
  nextPageStart?: number | null;
  values: T[];
};

export type BbCommentAnchor = {
  path?: string;
  srcPath?: string;
  line?: number;
  lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT' | string;
  fileType?: 'FROM' | 'TO' | string;
};

export type BbComment = {
  id?: number;
  version?: number;
  text?: string;
  author?: BbUser;
  createdDate?: number;
  updatedDate?: number;
  anchor?: BbCommentAnchor | null;
  commentAnchor?: BbCommentAnchor | null;
  threadResolved?: boolean;
  severity?: 'NORMAL' | 'BLOCKER' | string;
  state?: 'OPEN' | 'RESOLVED' | string;
  comments?: BbComment[];
};

export type BbActivity = {
  id?: number;
  action?: string;
  createdDate?: number;
  user?: BbUser;
  comment?: BbComment;
  commentAnchor?: BbCommentAnchor | null;
};

export type BbMergeability = {
  outcome?: 'CLEAN' | 'CONFLICTED' | 'UNKNOWN' | string;
  conflicted?: boolean;
  vetoes?: Array<{
    summaryMessage?: string;
    detailedMessage?: string;
  }>;
};

export type BbBuildStats = {
  successful?: number;
  inProgress?: number;
  failed?: number;
  cancelled?: number;
  unknown?: number;
};

export type BbBuildStatus = {
  key?: string;
  name?: string;
  url?: string;
  description?: string;
  state?: 'SUCCESSFUL' | 'INPROGRESS' | 'FAILED' | 'CANCELLED' | 'UNKNOWN' | string;
  createdDate?: number;
  updatedDate?: number;
  dateAdded?: number;
};

export type BbPathObject = {
  toString?: string;
  components?: string[];
};

export type BbChange = {
  path?: BbPathObject | string;
  srcPath?: BbPathObject | string;
  nodeType?: 'FILE' | 'DIRECTORY' | 'SUBMODULE' | string;
  type?: 'ADD' | 'COPY' | 'DELETE' | 'MODIFY' | 'MOVE' | 'UNKNOWN' | string;
};

export type BbCommit = {
  id?: string;
  displayId?: string;
  message?: string;
  authorTimestamp?: number;
  committerTimestamp?: number;
  author?: {
    name?: string;
    displayName?: string;
    emailAddress?: string;
  };
};

export type BbMergeStrategy = {
  id?: string;
  name?: string;
  flag?: string;
  enabled?: boolean;
};

export type BbPullRequestSettings = {
  mergeConfig?: {
    defaultStrategy?: BbMergeStrategy | null;
    strategies?: BbMergeStrategy[];
  } | null;
};

/** Advance pages strictly via `nextPageStart` while `isLastPage === false`. */
export async function collectPages<T>(
  bb: BB,
  path: string,
  query: Record<string, string>,
  maxPages = 20,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await bbGetJson<BbPage<T>>(bb, path, { ...query, start: String(start) });
    if (Array.isArray(res.values)) items.push(...res.values);
    if (res.isLastPage !== false) return { items, complete: true };
    if (typeof res.nextPageStart !== 'number') return { items, complete: true };
    start = res.nextPageStart;
  }
  return { items, complete: false };
}
