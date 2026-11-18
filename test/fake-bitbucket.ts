import http from 'node:http';

export type UserRec = {
  id: number;
  name: string;
  slug: string;
  displayName: string;
  emailAddress: string;
  type: 'NORMAL' | 'SERVICE';
  active: boolean;
};

type CloneLink = { name: string; href: string };

export type RepoRec = {
  id: number;
  slug: string;
  name: string;
  projectKey: string;
  projectId: number;
  projectName: string;
  defaultBranch: string | null;
  originRepoId?: number | null;
};

export type RefRec = {
  id: string;
  displayId: string;
  latestCommit: string;
  type: 'BRANCH';
  repository: {
    id: number;
    slug: string;
    name: string;
    project: { id: number; key: string; name: string; type: string };
    links?: { clone?: CloneLink[]; self?: Array<{ href: string }> };
  };
};

export type PR = {
  id: number;
  version: number;
  title: string;
  description: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  open: boolean;
  draft: boolean;
  createdDate: number;
  updatedDate: number;
  closedDate?: number;
  fromRef: RefRec;
  toRef: RefRec;
  author: UserRec;
  participants: Array<{ user: UserRec; role: string; approved: boolean; status: string; lastReviewedCommit?: string }>;
  reviewers: Array<{ user: UserRec; role: string; approved: boolean; status: string; lastReviewedCommit?: string }>;
  openTaskCount?: number;
  mergeOutcome: 'CLEAN' | 'CONFLICTED' | 'UNKNOWN';
  vetoes?: Array<{ summaryMessage: string; detailedMessage?: string }>;
};

export type CommentNode = {
  id: number;
  version: number;
  text: string;
  createdDate: number;
  updatedDate?: number;
  author: UserRec;
  threadResolved?: boolean;
  severity?: 'NORMAL' | 'BLOCKER';
  state?: 'OPEN' | 'RESOLVED';
  anchor?: { path: string; line?: number } | null;
  comments?: CommentNode[];
};

export type Activity = {
  id: number;
  action: string;
  createdDate: number;
  user: UserRec;
  comment?: CommentNode;
  commentAnchor?: { path: string; line?: number } | null;
};

export type FakeState = {
  users: Map<string, UserRec>; // keyed by user.name
  tokens: Map<string, string>; // token -> user.name
  projects: Map<number, { key: string; name: string }>;
  repos: Map<string, RepoRec>; // UPPER_KEY/slug
  repoById: Map<number, RepoRec>;
  prs: Map<number, PR>;
  prSeq: number;
  activities: Map<number, Activity[]>;
  comments: Map<number, Map<number, CommentNode>>; // prId -> commentId -> node
  commentSeq: number;
  buildStats: Map<string, { successful: number; inProgress: number; failed: number; cancelled: number; unknown: number }>;
  buildRuns: Map<
    string,
    Array<{ key: string; name: string; url?: string; description?: string; state: string; createdDate: number; updatedDate?: number }>
  >;
  pageCap: number;
  diffs: Map<number, string>;
  changes: Map<
    number,
    Array<{ path: { toString: string }; srcPath?: { toString: string }; type: string; nodeType: string }>
  >;
  commitLists: Map<
    number,
    Array<{ id: string; displayId: string; authorTimestamp: number; message: string; author: { name: string; displayName: string } }>
  >;
  mergeBases: Map<string, string>;
  files: Map<string, string>;
  lastMergeBody?: Record<string, unknown>;
  whoamiEnabled: boolean;
};

export type FakeBB = {
  origin: string;
  port: number;
  ctx: string;
  state: FakeState;
  seen: Array<{ method: string; path: string; authOk: boolean; qs?: string }>;
  close(): Promise<void>;
};

let uid = 1;
export function mkUser(over: Partial<UserRec> & { name: string }): UserRec {
  const slug = over.slug ?? over.name.replace(/@/g, '_');
  return {
    id: uid++,
    slug,
    displayName: over.displayName ?? over.name,
    emailAddress: over.emailAddress ?? (over.name.includes('@') ? over.name : `${over.name}@example.test`),
    type: 'NORMAL',
    active: true,
    ...over,
  };
}

export async function startFakeBitbucket(opts: { ctx?: string; port?: number } = {}): Promise<FakeBB> {
  const ctx = opts.ctx ?? '';
  const state: FakeState = {
    users: new Map(),
    tokens: new Map(),
    projects: new Map(),
    repos: new Map(),
    repoById: new Map(),
    prs: new Map(),
    prSeq: 100,
    activities: new Map(),
    comments: new Map(),
    commentSeq: 500,
    buildStats: new Map(),
    buildRuns: new Map(),
    pageCap: 3,
    diffs: new Map(),
    changes: new Map(),
    commitLists: new Map(),
    mergeBases: new Map(),
    files: new Map(),
    whoamiEnabled: true,
  };
  const seen: FakeBB['seen'] = [];

  const findRepoCaseInsensitive = (key: string, slug: string): RepoRec | undefined => {
    const target = `${key}/${slug}`.toLowerCase();
    for (const [k, v] of state.repos) {
      if (k.toLowerCase() === target) return v;
    }
    return undefined;
  };

  const findUserBySlugOrName = (id: string): UserRec | undefined => {
    for (const u of state.users.values()) {
      if (u.slug === id || u.name === id) return u;
    }
    return undefined;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const q = url.searchParams;
    const method = req.method ?? 'GET';
    const addr = server.address();
    const origin = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;

    const j = (status: number, body: unknown, ctype = 'application/json;charset=UTF-8'): void => {
      const txt = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': ctype });
      res.end(txt);
    };
    const notFound = (what: string): void => j(404, { errors: [{ context: null, message: `${what} not found`, exceptionName: null }] });

    const page = <T>(vals: T[], cap?: number): unknown => {
      const start = Number(q.get('start') ?? 0);
      const limit = Math.max(1, cap ?? Math.min(state.pageCap, Number(q.get('limit') ?? 25)));
      const sl = vals.slice(start, start + limit);
      const isLastPage = start + limit >= vals.length;
      return { size: sl.length, limit, start, isLastPage, nextPageStart: isLastPage ? null : start + limit, values: sl };
    };

    try {
      if (ctx && path !== '/' && !path.startsWith(`${ctx}/`) && path !== ctx) {
        return notFound('Context path');
      }
      const sp = ctx && path.startsWith(ctx) ? path.slice(ctx.length) || '/' : path;
      const REST_API_LATEST = '/rest/api/latest';
      const spa = sp.startsWith(REST_API_LATEST) ? sp.slice(REST_API_LATEST.length) : sp;

      if ((method === 'POST' || method === 'PUT') && !(req.headers['content-type'] ?? '').includes('application/json')) {
        return j(415, { errors: [{ message: 'Content-Type application/json is required' }] });
      }

      if (method === 'GET' && path === '/') {
        return j(
          200,
          `<html><head><meta name="ajs-context-path" content="${ctx}"></head><body>Bitbucket</body></html>`,
          'text/html; charset=utf-8',
        );
      }

      const auth = req.headers.authorization ?? '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const authedLogin = state.tokens.get(tok);

      // Probe endpoints can be hit unauthenticated (or return 401 when locked down)
      if (method === 'GET' && sp === '/rest/api/latest/application-properties') {
        seen.push({ method, path, authOk: Boolean(authedLogin), qs: url.search });
        return j(200, { displayName: 'Bitbucket', version: '10.5.0', buildNumber: '10005000' });
      }
      if (method === 'GET' && sp === '/status') {
        seen.push({ method, path, authOk: Boolean(authedLogin), qs: url.search });
        return j(200, { state: 'RUNNING' });
      }

      if (!authedLogin) {
        seen.push({ method, path, authOk: false, qs: url.search });
        return j(401, { errors: [{ context: null, message: 'Authentication failed.', exceptionName: null }] });
      }
      seen.push({ method, path, authOk: true, qs: url.search });

      if (method === 'GET' && sp === '/plugins/servlet/applinks/whoami') {
        if (!state.whoamiEnabled) return notFound('Applinks whoami disabled');
        return j(200, `${authedLogin}\n`, 'text/plain; charset=utf-8');
      }
      if (method === 'GET' && spa === '/inbox/pull-requests/count') {
        return j(200, { count: 1 });
      }
      if (method === 'GET' && spa === '/dashboard/pull-requests') {
        const myPrs = [...state.prs.values()].filter((p) => p.author.name === authedLogin);
        return j(200, page(myPrs.map((p) => serializePr(p, origin, ctx))));
      }

      let m: RegExpExecArray | null;
      if (method === 'GET' && spa === '/users') {
        const filter = (q.get('filter') ?? '').toLowerCase();
        const vals = [...state.users.values()].filter(
          (u) =>
            !filter ||
            u.name.toLowerCase().includes(filter) ||
            u.slug.toLowerCase().includes(filter) ||
            u.displayName.toLowerCase().includes(filter),
        );
        return j(200, page(vals, 100));
      }
      if (method === 'GET' && (m = /^\/users\/([^/]+)$/.exec(spa))) {
        const slug = decodeURIComponent(m[1]);
        const u = [...state.users.values()].find((cand) => cand.slug === slug);
        if (!u) return notFound('User');
        return j(200, u);
      }

      if (method === 'GET' && (m = /^\/rest\/build-status\/latest\/commits\/stats\/([^/]+)$/.exec(sp))) {
        const st = state.buildStats.get(decodeURIComponent(m[1])) ?? {
          successful: 0,
          inProgress: 0,
          failed: 0,
          cancelled: 0,
          unknown: 0,
        };
        return j(200, st);
      }
      if (method === 'GET' && (m = /^\/rest\/build-status\/latest\/commits\/([^/]+)$/.exec(sp))) {
        const runs = state.buildRuns.get(decodeURIComponent(m[1])) ?? [];
        return j(200, page(runs, 50));
      }

      if ((m = /^\/projects\/([^/]+)\/repos\/([^/]+)(\/.*)?$/.exec(spa))) {
        const key = decodeURIComponent(m[1]);
        const slug = decodeURIComponent(m[2]);
        const rest = m[3] ?? '';
        const rs = findRepoCaseInsensitive(key, slug);
        if (!rs) return notFound(`Repository ${key}/${slug}`);

        const repoJson = (r: RepoRec): Record<string, unknown> => {
          const originRepo = r.originRepoId ? state.repoById.get(r.originRepoId) : null;
          const lowerKey = r.projectKey.toLowerCase();
          return {
            id: r.id,
            slug: r.slug,
            name: r.name,
            scmId: 'git',
            state: 'AVAILABLE',
            project: {
              id: r.projectId,
              key: r.projectKey,
              name: r.projectName,
              type: r.projectKey.startsWith('~') ? 'PERSONAL' : 'NORMAL',
            },
            ...(originRepo ? { origin: repoJson(originRepo) } : {}),
            links: {
              self: [
                {
                  href: r.projectKey.startsWith('~')
                    ? `${origin}${ctx}/users/${r.projectKey.slice(1).toLowerCase()}/repos/${r.slug}/browse`
                    : `${origin}${ctx}/projects/${r.projectKey}/repos/${r.slug}/browse`,
                },
              ],
              clone: [
                { name: 'http', href: `http://gituser@127.0.0.1:${ (server.address() as { port: number }).port }${ctx}/scm/${lowerKey}/${r.slug}.git` },
                { name: 'ssh', href: `ssh://git@127.0.0.1:7999/${lowerKey}/${r.slug}.git` },
              ],
            },
          };
        };

        if (rest === '') {
          if (method !== 'GET') return j(405, { errors: [{ message: 'Method not allowed' }] });
          return j(200, repoJson(rs));
        }
        if (rest === '/default-branch') {
          if (!rs.defaultBranch) return notFound('Default branch');
          return j(200, { id: `refs/heads/${rs.defaultBranch}`, displayId: rs.defaultBranch, type: 'BRANCH' });
        }
        if (rest === '/branches') {
          const names = new Set<string>(rs.defaultBranch ? [rs.defaultBranch] : []);
          for (const pr of state.prs.values()) {
            if (pr.fromRef.repository.id === rs.id) names.add(pr.fromRef.displayId);
            if (pr.toRef.repository.id === rs.id) names.add(pr.toRef.displayId);
          }
          return j(200, page([...names].map((n) => ({ id: `refs/heads/${n}`, displayId: n }))));
        }
        if (rest === '/settings/pull-requests') {
          return j(200, {
            mergeConfig: {
              strategies: [
                { id: 'no-ff', flag: '--no-ff', enabled: true },
                { id: 'squash', flag: '--squash', enabled: true },
                { id: 'rebase-no-ff', flag: '--rebase', enabled: true },
              ],
              defaultStrategy: { id: 'no-ff', flag: '--no-ff', enabled: true },
            },
          });
        }
        if (rest.startsWith('/raw/')) {
          const fp = rest.slice(5).split('/').map(decodeURIComponent).join('/');
          const at = q.get('at') ?? '';
          const content = state.files.get(`${rs.id}:${at}:${fp}`);
          if (content === undefined) return notFound('File');
          return j(200, content, 'text/plain; charset=utf-8');
        }
        if ((m = /^\/commits\/([^/]+)\/merge-base$/.exec(rest))) {
          const sha = decodeURIComponent(m[1]);
          const other = q.get('otherCommitId') ?? '';
          const base = state.mergeBases.get(`${rs.id}:${sha}:${other}`);
          if (base === undefined) return notFound('Merge base');
          return j(200, { id: base, displayId: base.slice(0, 11) });
        }
        if (rest === '/pull-requests') {
          if (method === 'GET') {
            let vals = [...state.prs.values()].filter((pr) => {
              const dir = (q.get('direction') ?? 'INCOMING').toUpperCase();
              return dir === 'OUTGOING' ? pr.fromRef.repository.id === rs.id : pr.toRef.repository.id === rs.id;
            });
            const at = q.get('at');
            if (at) {
              const dir = (q.get('direction') ?? 'INCOMING').toUpperCase();
              vals = vals.filter((pr) => (dir === 'OUTGOING' ? pr.fromRef.id === at : pr.toRef.id === at));
            }
            const stateF = (q.get('state') ?? 'OPEN').toUpperCase();
            if (stateF !== 'ALL') vals = vals.filter((pr) => pr.state === stateF);
            const ft = q.get('filterText');
            if (ft) {
              vals = vals.filter(
                (pr) =>
                  pr.title.toLowerCase().includes(ft.toLowerCase()) ||
                  pr.description.toLowerCase().includes(ft.toLowerCase()),
              );
            }
            const user1 = q.get('username.1');
            const role1 = (q.get('role.1') ?? '').toUpperCase();
            if (user1) {
              vals = vals.filter((pr) => {
                if (role1 === 'AUTHOR') return pr.author.name === user1 || pr.author.slug === user1;
                if (role1 === 'REVIEWER') {
                  return pr.reviewers.some((r) => r.user.name === user1 || r.user.slug === user1);
                }
                return true;
              });
            }
            vals.sort((a, b) => b.updatedDate - a.updatedDate);
            return j(200, page(vals.map((p) => serializePr(p, origin, ctx))));
          }
          if (method === 'POST') {
            const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
            if (!body.fromRef?.repository?.id || !body.toRef?.repository?.id) {
              return j(400, { errors: [{ message: 'fromRef and toRef repository ids are required' }] });
            }
            const srcRepo = state.repoById.get(Number(body.fromRef.repository.id)) ?? rs;
            const tgtRepo = state.repoById.get(Number(body.toRef.repository.id)) ?? rs;
            const author = state.users.get(authedLogin) ?? mkUser({ name: authedLogin });
            const id = ++state.prSeq;
            const now = Date.now();
            const headDisp = String(body.fromRef.id ?? '').replace(/^refs\/heads\//, '');
            const baseDisp = String(body.toRef.id ?? '').replace(/^refs\/heads\//, '');
            const created: PR = {
              id,
              version: 0,
              title: String(body.title ?? ''),
              description: typeof body.description === 'string' ? body.description : '',
              state: 'OPEN',
              open: true,
              draft: body.draft === true,
              createdDate: now,
              updatedDate: now,
              fromRef: mkRepoRef(headDisp, '1111111111111111111111111111111111111111', srcRepo, origin, ctx),
              toRef: mkRepoRef(baseDisp, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tgtRepo, origin, ctx),
              author,
              participants: [],
              reviewers: Array.isArray(body.reviewers)
                ? body.reviewers
                    .map((r: any) => findUserBySlugOrName(String(r?.user?.name ?? '')))
                    .filter((u: UserRec | undefined): u is UserRec => Boolean(u))
                    .map((user: UserRec) => ({ user, role: 'REVIEWER', approved: false, status: 'UNAPPROVED' }))
                : [],
              mergeOutcome: 'CLEAN',
            };
            state.prs.set(id, created);
            return j(201, serializePr(created, origin, ctx));
          }
        }

        const dm = /^\/pull-requests\/(\d+)\.diff$/.exec(rest);
        if (dm) {
          const pr = state.prs.get(Number(dm[1]));
          if (!pr || pr.toRef.repository.id !== rs.id) return notFound('Pull request');
          const diff = state.diffs.get(pr.id) ?? '';
          return j(200, diff, 'text/plain; charset=utf-8');
        }

        const pm = /^\/pull-requests\/(\d+)(?:\/(.+))?$/.exec(rest);
        if (pm) {
          const prId = Number(pm[1]);
          const sub = pm[2] ?? '';
          const pr = state.prs.get(prId);
          if (!pr || pr.toRef.repository.id !== rs.id) return notFound('Pull request');

          if (sub === '') {
            if (method === 'GET') return j(200, serializePr(pr, origin, ctx));
            if (method === 'PUT') {
              const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
              if (body.version !== pr.version) {
                return j(409, { errors: [{ message: 'You are attempting to modify a pull request based on out-of-date information.' }] });
              }
              if (typeof body.title === 'string') pr.title = body.title;
              if (typeof body.description === 'string') pr.description = body.description;
              if (typeof body.draft === 'boolean') pr.draft = body.draft;
              // Real Bitbucket DC wipes reviewers if `reviewers` is omitted on PUT!
              const incomingReviewers = Array.isArray(body.reviewers) ? body.reviewers : [];
              pr.reviewers = incomingReviewers
                .map((rv: any) => findUserBySlugOrName(String(rv?.user?.name ?? '')))
                .filter((u: UserRec | undefined): u is UserRec => Boolean(u))
                .map((u: UserRec) => {
                  const prev = pr.reviewers.find((p) => p.user.id === u.id);
                  return prev ?? { user: u, role: 'REVIEWER', approved: false, status: 'UNAPPROVED' };
                });
              pr.version += 1;
              pr.updatedDate = Date.now();
              return j(200, serializePr(pr, origin, ctx));
            }
          }

          if (sub === 'changes') return j(200, page(state.changes.get(pr.id) ?? [], 1000));
          if (sub === 'commits') return j(200, page(state.commitLists.get(pr.id) ?? [], 50));
          if (sub === 'merge') {
            if (method === 'GET') {
              return j(200, {
                outcome: pr.mergeOutcome,
                conflicted: pr.mergeOutcome === 'CONFLICTED',
                vetoes: pr.vetoes ?? [],
              });
            }
            if (method === 'POST') {
              const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
              state.lastMergeBody = body;
              if (body.version !== undefined && Number(body.version) !== pr.version) {
                return j(409, { errors: [{ message: 'Version mismatch on merge' }] });
              }
              if (pr.mergeOutcome === 'CONFLICTED' || (pr.vetoes && pr.vetoes.length > 0) || !pr.open) {
                return j(409, { errors: [{ message: pr.vetoes?.[0]?.detailedMessage ?? 'Pull request cannot be merged' }] });
              }
              pr.state = 'MERGED';
              pr.open = false;
              pr.closedDate = Date.now();
              pr.version += 1;
              return j(200, serializePr(pr, origin, ctx));
            }
          }
          if (sub === 'decline' || sub === 'reopen') {
            if (method !== 'POST') return j(405, { errors: [{ message: 'Method not allowed' }] });
            const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
            if (body.version !== undefined && Number(body.version) !== pr.version) {
              return j(409, { errors: [{ message: 'Version mismatch' }] });
            }
            pr.state = sub === 'decline' ? 'DECLINED' : 'OPEN';
            pr.open = sub !== 'decline';
            if (sub === 'decline') pr.closedDate = Date.now();
            pr.version += 1;
            return j(200, serializePr(pr, origin, ctx));
          }
          if (sub === 'activities') return j(200, page(state.activities.get(pr.id) ?? []));
          if (sub === 'comments') {
            if (method === 'POST') {
              const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
              const author = state.users.get(authedLogin) ?? pr.author;
              const id = ++state.commentSeq;
              let prComments = state.comments.get(pr.id);
              if (!prComments) {
                prComments = new Map();
                state.comments.set(pr.id, prComments);
              }
              const node: CommentNode = {
                id,
                version: 0,
                text: String(body.text ?? ''),
                createdDate: Date.now(),
                author,
              };
              prComments.set(id, node);
              return j(201, node);
            }
          }
          const cmMatch = /^comments\/(\d+)$/.exec(sub);
          if (cmMatch) {
            const cid = Number(cmMatch[1]);
            const node = state.comments.get(pr.id)?.get(cid);
            if (!node) return notFound('Comment');
            if (method === 'GET') return j(200, node);
            if (method === 'PUT') {
              const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
              if (body.version !== node.version) {
                return j(409, { errors: [{ message: 'Comment version conflict' }] });
              }
              node.text = String(body.text ?? '');
              node.version += 1;
              node.updatedDate = Date.now();
              return j(200, node);
            }
            if (method === 'DELETE') {
              const dv = q.get('version');
              if (dv === null || Number(dv) !== node.version) {
                return j(409, { errors: [{ message: 'Comment version conflict' }] });
              }
              if (node.comments && node.comments.length > 0) {
                return j(409, { errors: [{ message: 'This comment cannot be deleted because it has replies.' }] });
              }
              state.comments.get(pr.id)?.delete(cid);
              res.writeHead(204);
              return void res.end();
            }
          }
          const pp = /^participants\/([^/]+)$/.exec(sub);
          if (pp) {
            if (method !== 'PUT') return j(405, { errors: [{ message: 'Method not allowed' }] });
            const userSlug = decodeURIComponent(pp[1]);
            const user = [...state.users.values()].find((u) => u.slug === userSlug);
            if (!user) return notFound(`Participant by slug ${userSlug}`);
            if (user.id === pr.author.id) {
              return j(400, { errors: [{ message: 'Pull request authors cannot approve their own pull request.' }] });
            }
            const body = JSON.parse((await readAll(req)) || '{}') as Record<string, any>;
            if (body.lastReviewedCommit && body.lastReviewedCommit !== pr.fromRef.latestCommit) {
              return j(409, { errors: [{ message: 'Pull request has been updated since lastReviewedCommit.' }] });
            }
            const status = String(body.status ?? 'UNAPPROVED');
            const entry = {
              user,
              role: 'PARTICIPANT',
              approved: status === 'APPROVED',
              status,
              lastReviewedCommit: pr.fromRef.latestCommit,
            };
            pr.participants = pr.participants.filter((p) => p.user.id !== user.id);
            pr.participants.push(entry);
            return j(200, entry);
          }
        }
      }
      return notFound(`Route ${path}`);
    } catch (err) {
      return j(500, { errors: [{ message: err instanceof Error ? err.message : 'Internal server error' }] });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const serverAddr = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${serverAddr.port}`,
    port: serverAddr.port,
    ctx,
    state,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export function mkRepoRef(displayId: string, latestCommit: string, repo: RepoRec, origin: string, ctx: string): RefRec {
  const lowerKey = repo.projectKey.toLowerCase();
  const hostPart = origin.replace(/^https?:\/\//, '');
  return {
    id: `refs/heads/${displayId}`,
    displayId,
    latestCommit,
    type: 'BRANCH',
    repository: {
      id: repo.id,
      slug: repo.slug,
      name: repo.name,
      project: {
        id: repo.projectId,
        key: repo.projectKey,
        name: repo.projectName,
        type: repo.projectKey.startsWith('~') ? 'PERSONAL' : 'NORMAL',
      },
      links: {
        clone: [
          { name: 'http', href: `http://gituser@${hostPart}${ctx}/scm/${lowerKey}/${repo.slug}.git` },
          { name: 'ssh', href: `ssh://git@127.0.0.1:7999/${lowerKey}/${repo.slug}.git` },
        ],
        self: [{ href: `${origin}${ctx}/projects/${repo.projectKey}/repos/${repo.slug}/browse` }],
      },
    },
  };
}

function serializePr(pr: PR, origin: string, ctx: string): Record<string, unknown> {
  const tgt = pr.toRef.repository;
  return {
    id: pr.id,
    version: pr.version,
    title: pr.title,
    description: pr.description,
    state: pr.state,
    open: pr.open,
    closed: !pr.open,
    draft: pr.draft,
    locked: false,
    createdDate: pr.createdDate,
    updatedDate: pr.updatedDate,
    ...(pr.closedDate ? { closedDate: pr.closedDate } : {}),
    fromRef: pr.fromRef,
    toRef: pr.toRef,
    author: { user: pr.author, role: 'AUTHOR', approved: false, status: 'UNAPPROVED' },
    participants: pr.participants,
    reviewers: pr.reviewers,
    properties: pr.openTaskCount !== undefined ? { openTaskCount: pr.openTaskCount } : {},
    links: {
      self: [{ href: `${origin}${ctx}/projects/${tgt.project.key}/repos/${tgt.slug}/pull-requests/${pr.id}` }],
    },
  };
}

function readAll(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Outbound proxy double matching OpenChamber's `outbound-handles.js`
// ---------------------------------------------------------------------------

export type ProxyHandle = { token: string | null; role: 'read' | 'write' };

export type OutboundProxy = {
  origin: string;
  close(): Promise<void>;
  log: Array<{ handle: string; method: string; path: string; status?: number; forwarded: boolean; refused?: string }>;
};

export async function startOutboundProxy(fake: FakeBB, registry: Map<string, ProxyHandle>): Promise<OutboundProxy> {
  const log: OutboundProxy['log'] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rp = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || rp !== '/source-control/outbound') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }));
    }
    const handleId = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const reg = registry.get(handleId);
    const rpc = JSON.parse(body || '{}') as {
      method?: string;
      path?: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: string;
    };
    const method = String(rpc.method ?? 'GET').toUpperCase();
    const path = String(rpc.path ?? '/');
    if (!reg) {
      log.push({ handle: handleId, method, path, forwarded: false, refused: 'UNKNOWN_HANDLE' });
      res.writeHead(403, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { code: 'UNKNOWN_HANDLE', message: 'unknown handle' } }));
    }
    if (reg.role === 'read' && method !== 'GET') {
      log.push({ handle: handleId, method, path, forwarded: false, refused: 'METHOD_NOT_ALLOWED' });
      res.writeHead(403, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'read-only handle' } }));
    }
    const qs = rpc.query && Object.keys(rpc.query).length > 0 ? `?${new URLSearchParams(rpc.query).toString()}` : '';
    const fwdHeaders: Record<string, string> = {};
    if (reg.token) fwdHeaders.authorization = `Bearer ${reg.token}`;
    for (const h of ['accept', 'content-type', 'if-none-match', 'range']) {
      if (rpc.headers?.[h]) fwdHeaders[h] = rpc.headers[h];
    }
    const resp = await fetch(`${fake.origin}${path}${qs}`, {
      method,
      headers: fwdHeaders,
      redirect: 'manual',
      body: method === 'GET' ? undefined : rpc.body,
    });
    const text = await resp.text();
    const headers: Record<string, string> = {};
    // Mirror OpenChamber's strict header allowlist (x-ausername and location are NOT forwarded!)
    for (const allowed of ['content-type', 'link', 'etag', 'x-total-count', 'x-total', 'retry-after']) {
      const val = resp.headers.get(allowed);
      if (val) headers[allowed] = val;
    }
    log.push({ handle: handleId, method, path, status: resp.status, forwarded: true });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: resp.status, headers, body: text }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
