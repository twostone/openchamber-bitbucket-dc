import type {
  BbActivity,
  BbBuildStats,
  BbBuildStatus,
  BbChange,
  BbComment,
  BbCommentAnchor,
  BbCommit,
  BbMergeability,
  BbPathObject,
  BbPullRequest,
  BbRepo,
  BbUser,
} from './bitbucket.js';
import { iso, type CallCtx, type DtoProject, type DtoUser, type Identity } from './types.js';

export function mapForgeUser(u?: BbUser | null): {
  id: number | string;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
} | null {
  if (!u) return null;
  const login = (u.name ?? u.slug ?? '').trim();
  if (!login) return null;
  const id = typeof u.id === 'number' && Number.isSafeInteger(u.id) && u.id > 0 ? u.id : (u.slug ?? login);
  const out: { id: number | string; login: string; name?: string; email?: string; avatarUrl?: string } = { id, login };
  if (u.displayName) out.name = u.displayName;
  if (u.emailAddress) out.email = u.emailAddress;
  if (u.avatarUrl) out.avatarUrl = u.avatarUrl;
  return out;
}

export function mapUser(u: BbUser | null | undefined, identity: Identity): DtoUser | null {
  const f = mapForgeUser(u);
  if (!f) return null;
  const out: DtoUser = {
    ...identity,
    id: String(f.id),
    username: f.login,
  };
  if (f.name) out.name = f.name;
  if (f.email) out.email = f.email;
  if (f.avatarUrl) out.avatarUrl = f.avatarUrl;
  return out;
}

export function webRepoUrl(origin: string, ctx: string, key: string, slug: string): string {
  const enc = encodeURIComponent;
  if (key.startsWith('~')) {
    return `${origin}${ctx}/users/${enc(key.slice(1))}/repos/${enc(slug)}`;
  }
  return `${origin}${ctx}/projects/${enc(key)}/repos/${enc(slug)}`;
}

export function webPrUrl(origin: string, ctx: string, key: string, slug: string, number: number): string {
  return `${webRepoUrl(origin, ctx, key, slug)}/pull-requests/${number}`;
}

function sanitizeCloneUrl(rawUrl: string | undefined, instanceOrigin: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
    const base = new URL(instanceOrigin);
    base.pathname = u.pathname;
    base.search = '';
    base.hash = '';
    return base.href;
  } catch {
    return undefined;
  }
}

export function mapProject(
  call: CallCtx,
  raw: BbRepo,
  dtoOwner: string,
  opts: { defaultBranch?: string | null; remoteName?: string | null } = {},
): DtoProject {
  const selfHref = raw.links?.self?.[0]?.href?.replace(/\/browse\/?$/, '');
  const rawHttpClone = raw.links?.clone?.find((c) => (c.name ?? '').toLowerCase() === 'http')?.href;
  const httpClone = sanitizeCloneUrl(rawHttpClone, call.origin);
  const sshClone = raw.links?.clone?.find((c) => (c.name ?? '').toLowerCase() === 'ssh')?.href;
  const proj: DtoProject = {
    ...call.identity,
    id: String(raw.id),
    owner: dtoOwner,
    name: raw.slug,
    url: selfHref || webRepoUrl(call.origin, call.ctx, raw.project?.key ?? dtoOwner, raw.slug),
  };
  if (httpClone) proj.cloneUrl = httpClone;
  if (sshClone) proj.sshUrl = sshClone;
  if (opts.defaultBranch) proj.defaultBranch = opts.defaultBranch;
  if (opts.remoteName !== undefined) proj.remoteName = opts.remoteName;
  return proj;
}

// ---------------------------------------------------------------------------
// Pull requests & mergeability
// ---------------------------------------------------------------------------

export function mapPrState(pr: BbPullRequest): 'open' | 'closed' | 'merged' {
  const s = (pr.state ?? '').toUpperCase();
  if (s === 'OPEN') return 'open';
  if (s === 'MERGED') return 'merged';
  return 'closed';
}

export type MergeAssessment = {
  canMerge: boolean;
  mergeable: boolean | null;
  mergeableState: 'clean' | 'dirty' | 'blocked' | 'unknown';
  vetoes: Array<{ summaryMessage?: string; detailedMessage?: string }>;
};

export function assessMerge(draft: boolean, info?: BbMergeability | null): MergeAssessment {
  if (!info) {
    return { canMerge: false, mergeable: null, mergeableState: 'unknown', vetoes: [] };
  }
  const conflicted = info.conflicted === true || info.outcome === 'CONFLICTED';
  const vetoes = Array.isArray(info.vetoes) ? info.vetoes : [];
  const clean = info.outcome === 'CLEAN';
  return {
    canMerge: !draft && clean && !conflicted && vetoes.length === 0,
    mergeable: info.outcome === 'UNKNOWN' && !conflicted ? null : !conflicted,
    mergeableState: conflicted ? 'dirty' : vetoes.length > 0 ? 'blocked' : clean ? 'clean' : 'unknown',
    vetoes,
  };
}

export function buildSubmitRequirements(
  assessment: MergeAssessment | undefined,
  openTaskCount: number | undefined,
): Array<{ name: string; status: 'satisfied' | 'unsatisfied'; description?: string }> {
  if (!assessment) return [];
  const reqs: Array<{ name: string; status: 'satisfied' | 'unsatisfied'; description?: string }> =
    assessment.vetoes.map((v) => {
      const item: { name: string; status: 'unsatisfied'; description?: string } = {
        name: v.summaryMessage || 'Merge check',
        status: 'unsatisfied',
      };
      if (v.detailedMessage) item.description = v.detailedMessage;
      return item;
    });
  const hasTaskVeto = assessment.vetoes.some(
    (v) => /task/i.test(v.summaryMessage ?? '') || /task/i.test(v.detailedMessage ?? ''),
  );
  if (typeof openTaskCount === 'number' && openTaskCount > 0 && !hasTaskVeto) {
    reqs.push({
      name: `Open tasks (${openTaskCount})`,
      status: 'unsatisfied',
      description: 'All pull request tasks must be resolved',
    });
  }
  return reqs;
}

export function mapPull(
  call: CallCtx,
  raw: BbPullRequest,
  project: DtoProject,
  merge?: MergeAssessment,
  headProject?: DtoProject | null,
): Record<string, unknown> {
  const state = mapPrState(raw);
  const prUrl =
    raw.links?.self?.[0]?.href?.replace(/\/overview\/?$/, '') ??
    webPrUrl(call.origin, call.ctx, raw.toRef?.repository?.project?.key ?? project.owner, project.name, raw.id);
  const out: Record<string, unknown> = {
    ...call.identity,
    id: `${project.id}#${raw.id}`,
    number: Number(raw.id),
    project,
    title: raw.title ?? '',
    url: prUrl,
    state,
    draft: raw.draft === true,
    base: raw.toRef?.displayId ?? '',
    head: raw.fromRef?.displayId ?? '',
    author: mapUser(raw.author?.user, call.identity),
    labels: [],
  };
  if (typeof raw.description === 'string') out.body = raw.description;
  if (raw.fromRef?.latestCommit) out.headSha = raw.fromRef.latestCommit;
  const createdAt = iso(raw.createdDate);
  const updatedAt = iso(raw.updatedDate);
  if (createdAt) out.createdAt = createdAt;
  if (updatedAt) out.updatedAt = updatedAt;
  if (headProject) out.headProject = headProject;
  if (state === 'open' && merge) {
    out.mergeable = merge.mergeable;
    out.mergeableState = merge.mergeableState;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diff & changed files (`RestChange` in 10.5)
// ---------------------------------------------------------------------------

export type ParsedDiffChunk = {
  patch: string;
  additions: number;
  deletions: number;
  previousPath?: string;
};

export function splitUnifiedDiff(diff: string): Map<string, ParsedDiffChunk> {
  const parts = new Map<string, ParsedDiffChunk>();
  if (!diff) return parts;
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const plus = lines.find((l) => l.startsWith('+++ '));
    const minus = lines.find((l) => l.startsWith('--- '));
    const renamedFrom = lines.find((l) => l.startsWith('rename from '));
    const renamedTo = lines.find((l) => l.startsWith('rename to '));
    let path = '';
    if (plus && plus !== '+++ /dev/null') path = plus.slice(4).replace(/^b\//, '');
    else if (renamedTo) path = renamedTo.slice('rename to '.length);
    else if (minus && minus !== '--- /dev/null') path = minus.slice(4).replace(/^a\//, '');
    else path = /^diff --git a\/.+? b\/(.+)$/.exec(lines[0] ?? '')?.[1] ?? '';
    path = path.replace(/\t.*$/, '');
    if (!path) continue;

    let previousPath: string | undefined;
    if (renamedFrom) {
      previousPath = renamedFrom.slice('rename from '.length).replace(/\t.*$/, '');
    } else if (minus && minus !== '--- /dev/null') {
      const oldPath = minus.slice(4).replace(/^a\//, '').replace(/\t.*$/, '');
      if (oldPath && oldPath !== path) previousPath = oldPath;
    }

    let additions = 0;
    let deletions = 0;
    for (const l of lines) {
      if (l.startsWith('+') && !l.startsWith('+++')) additions += 1;
      else if (l.startsWith('-') && !l.startsWith('---')) deletions += 1;
    }
    const patch = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
    parts.set(path, { patch, additions, deletions, previousPath });
  }
  return parts;
}

function pathString(p?: BbPathObject | string | null): string {
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (typeof p.toString === 'string') return p.toString;
  if (Array.isArray(p.components)) return p.components.join('/');
  return '';
}

export type MappedFile = {
  path: string;
  status: 'added' | 'removed' | 'renamed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export function mapChangedFiles(entries: BbChange[], patches: Map<string, ParsedDiffChunk>): MappedFile[] {
  const files: MappedFile[] = [];
  for (const entry of entries) {
    if (entry.nodeType === 'DIRECTORY') continue;
    const filePath = pathString(entry.path) || pathString(entry.srcPath);
    if (!filePath) continue;
    const srcPath = pathString(entry.srcPath);
    const kind = (entry.type ?? '').toUpperCase();
    let status: MappedFile['status'] = 'modified';
    if (kind === 'ADD') status = 'added';
    else if (kind === 'DELETE') status = 'removed';
    else if (kind === 'MOVE' || kind === 'COPY') status = 'renamed';

    const chunk = patches.get(filePath) ?? (srcPath ? patches.get(srcPath) : undefined);
    const additions = chunk?.additions ?? 0;
    const deletions = chunk?.deletions ?? 0;
    const item: MappedFile = {
      path: filePath,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    };
    if (chunk?.patch) item.patch = chunk.patch;
    files.push(item);
  }
  if (files.length === 0 && patches.size > 0) {
    for (const [filePath, chunk] of patches) {
      files.push({
        path: filePath,
        status: chunk.previousPath ? 'renamed' : 'modified',
        additions: chunk.additions,
        deletions: chunk.deletions,
        changes: chunk.additions + chunk.deletions,
        patch: chunk.patch,
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Activities -> threaded issueComments & reviewComments
// ---------------------------------------------------------------------------

function extractAnchor(activity: BbActivity, comment: BbComment): { path: string; line: number | null } | null {
  const anchor: BbCommentAnchor | null | undefined =
    activity.commentAnchor ?? comment.commentAnchor ?? comment.anchor;
  const p = anchor?.path || anchor?.srcPath;
  if (typeof p === 'string' && p.length > 0) {
    return { path: p, line: typeof anchor?.line === 'number' ? anchor.line : null };
  }
  return null;
}

export function mapActivitiesToComments(
  activities: BbActivity[],
  identity: Identity,
  prUrl: string,
  viewerLogin: string | null,
): { issueComments: Array<Record<string, unknown>>; reviewComments: Array<Record<string, unknown>> } {
  const issueComments: Array<Record<string, unknown>> = [];
  const reviewComments: Array<Record<string, unknown>> = [];

  const isMine = (author?: BbUser) => {
    if (!viewerLogin || !author) return false;
    return author.name === viewerLogin || author.slug === viewerLogin;
  };

  // Pass 1: collect all nested reply IDs across every activity's comment tree so
  // standalone `commentAction: "REPLIED"` activities are never emitted twice as roots.
  const childIds = new Set<string>();
  const collectChildren = (c: BbComment) => {
    for (const reply of c.comments ?? []) {
      if (reply.id != null) childIds.add(String(reply.id));
      collectChildren(reply);
    }
  };
  const commentActivities = activities.filter(
    (a) => (a.action === 'COMMENTED' || a.action === 'REVIEW_COMMENTED') && a.comment,
  );
  for (const activity of commentActivities) {
    collectChildren(activity.comment!);
  }

  const visitedIds = new Set<string>();
  for (const activity of commentActivities) {
    const root = activity.comment!;
    const rootId = String(root.id ?? '');
    if (!rootId || childIds.has(rootId) || visitedIds.has(rootId)) continue;

    const rootAnchor = extractAnchor(activity, root);
    const hasReplies = Array.isArray(root.comments) && root.comments.length > 0;
    const isThreaded = hasReplies || root.threadResolved !== undefined;
    const threadId = rootId || String(activity.id ?? '');

    const visit = (c: BbComment, isFirst: boolean) => {
      const cid = String(c.id ?? '');
      if (!cid || visitedIds.has(cid)) return;
      visitedIds.add(cid);
      const replies = Array.isArray(c.comments) ? c.comments : [];
      const mine = isMine(c.author);
      const item: Record<string, unknown> = {
        ...identity,
        id: cid,
        url: `${prUrl}?commentId=${encodeURIComponent(cid)}`,
        body: c.text ?? '',
        author: mapUser(c.author, identity),
        canUpdate: mine,
        canDelete: mine && replies.length === 0,
      };
      const createdAt = iso(c.createdDate);
      const updatedAt = iso(c.updatedDate);
      if (createdAt) item.createdAt = createdAt;
      if (updatedAt) item.updatedAt = updatedAt;
      if (isThreaded) {
        item.thread = {
          id: threadId,
          resolved: Boolean(root.threadResolved),
          resolvable: false,
          first: isFirst,
          canResolve: false,
          canReply: false,
        };
      }
      if (rootAnchor) {
        item.path = rootAnchor.path;
        item.line = rootAnchor.line;
        reviewComments.push(item);
      } else {
        issueComments.push(item);
      }
      for (const reply of replies) visit(reply, false);
    };

    visit(root, true);
  }

  const byTime = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  issueComments.sort(byTime);
  reviewComments.sort(byTime);
  return { issueComments, reviewComments };
}

// ---------------------------------------------------------------------------
// Verdicts, reviewers & commits
// ---------------------------------------------------------------------------

export function mapVerdicts(
  pr: BbPullRequest,
  identity: Identity,
  prUrl: string,
): Array<{ state: 'approved' | 'changes_requested'; author?: DtoUser; createdAt: string | null; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ state: 'approved' | 'changes_requested'; author?: DtoUser; createdAt: string | null; url: string }> = [];
  for (const entry of [...(pr.reviewers ?? []), ...(pr.participants ?? [])]) {
    const u = entry.user;
    const key = u?.name ?? u?.slug ?? '';
    if (!key || seen.has(key)) continue;
    const st = (entry.status ?? '').toUpperCase();
    if (st !== 'APPROVED' && st !== 'NEEDS_WORK') continue;
    seen.add(key);
    const author = mapUser(u, identity);
    out.push({
      state: st === 'APPROVED' ? 'approved' : 'changes_requested',
      ...(author ? { author } : {}),
      createdAt: null,
      url: prUrl,
    });
  }
  return out;
}

export function mapReviewers(pr: BbPullRequest, identity: Identity): DtoUser[] {
  const seen = new Set<string>();
  const out: DtoUser[] = [];
  for (const r of pr.reviewers ?? []) {
    const mapped = mapUser(r.user, identity);
    if (!mapped || seen.has(mapped.username)) continue;
    seen.add(mapped.username);
    out.push(mapped);
  }
  return out;
}

export function mapCommit(c: BbCommit, origin: string, ctx: string, key: string, slug: string): {
  sha: string;
  headline: string;
  authorName: string | null;
  committedAt: string | null;
  url: string | null;
} | null {
  if (!c.id) return null;
  const headline = (c.message ?? '').split(/\r?\n/)[0] ?? '';
  return {
    sha: c.id,
    headline,
    authorName: c.author?.displayName ?? c.author?.name ?? null,
    committedAt: iso(c.committerTimestamp ?? c.authorTimestamp) ?? null,
    url: `${webRepoUrl(origin, ctx, key, slug)}/commits/${encodeURIComponent(c.id)}`,
  };
}

// ---------------------------------------------------------------------------
// CI (`RestBuildStats` & `RestBuildStatus`)
// ---------------------------------------------------------------------------

export type CiSummaryDto = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  pending: number;
};

export function mapCiStats(stats?: BbBuildStats | null): CiSummaryDto | null {
  if (!stats) return null;
  const success = Number(stats.successful ?? 0);
  const pending = Number(stats.inProgress ?? 0);
  const failure = Number(stats.failed ?? 0) + Number(stats.cancelled ?? 0);
  const unknown = Number(stats.unknown ?? 0);
  const total = success + pending + failure + unknown;
  if (total === 0) return null;
  const state: CiSummaryDto['state'] =
    failure > 0 ? 'failure' : pending > 0 ? 'pending' : success > 0 ? 'success' : 'unknown';
  return { state, total, success, failure, pending };
}

export function mapCiRuns(
  runs: BbBuildStatus[],
  identity: Identity,
): { summary: CiSummaryDto; runs: Array<Record<string, unknown>> } | null {
  if (runs.length === 0) return null;
  let success = 0;
  let failure = 0;
  let pending = 0;
  const mappedRuns = runs.map((r, idx) => {
    const st = (r.state ?? '').toUpperCase();
    const isPending = st === 'INPROGRESS';
    const isSuccess = st === 'SUCCESSFUL';
    const isFail = st === 'FAILED' || st === 'CANCELLED';
    if (isSuccess) success += 1;
    else if (isFail) failure += 1;
    else if (isPending) pending += 1;

    const run: Record<string, unknown> = {
      ...identity,
      id: String(r.key ?? `build-${idx}`),
      name: r.name || r.key || 'Build',
      status: isPending ? 'in_progress' : 'completed',
      conclusion: isSuccess ? 'success' : isFail ? 'failure' : null,
    };
    if (r.url && /^https?:\/\//i.test(r.url)) run.detailsUrl = r.url;
    if (r.description) run.output = { title: r.description };
    const started = iso(r.createdDate ?? r.dateAdded);
    const updated = iso(r.updatedDate);
    if (started) run.startedAt = started;
    if (!isPending && updated) run.completedAt = updated;
    return run;
  });
  const state: CiSummaryDto['state'] =
    failure > 0 ? 'failure' : pending > 0 ? 'pending' : success > 0 ? 'success' : 'unknown';
  return {
    summary: { state, total: runs.length, success, failure, pending },
    runs: mappedRuns,
  };
}

// ---------------------------------------------------------------------------
// PR Stacks (bottom-first chain of open PRs targeting each other's branches)
// ---------------------------------------------------------------------------

export type StackLayer = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  head: string;
};

export function computeStack(
  branchPr: BbPullRequest,
  allOpen: BbPullRequest[],
  repoId: number,
  urlFor: (pr: BbPullRequest) => string,
): { number: number | null; base: string; layers: StackLayer[] } | null {
  const sameRepoOpen = allOpen.filter(
    (p) => p.fromRef?.repository?.id === repoId && p.toRef?.repository?.id === repoId && mapPrState(p) === 'open',
  );
  const visited = new Set<number>([branchPr.id]);
  let bottom: BbPullRequest = branchPr;
  for (let i = 0; i < 32; i++) {
    const baseBranch = bottom.toRef?.displayId;
    if (!baseBranch) break;
    const below = sameRepoOpen.find((p) => !visited.has(p.id) && p.fromRef?.displayId === baseBranch);
    if (!below) break;
    visited.add(below.id);
    bottom = below;
  }

  const chain: BbPullRequest[] = [bottom];
  const inChain = new Set<number>([bottom.id]);
  let cursor: BbPullRequest = bottom;
  for (let i = 0; i < 32; i++) {
    const headBranch = cursor.fromRef?.displayId;
    if (!headBranch) break;
    const above = sameRepoOpen.find((p) => !inChain.has(p.id) && p.toRef?.displayId === headBranch);
    if (!above) break;
    inChain.add(above.id);
    chain.push(above);
    cursor = above;
  }

  if (chain.length < 2) return null;
  return {
    number: Number(branchPr.id),
    base: bottom.toRef?.displayId ?? '',
    layers: chain.map((p) => ({
      number: Number(p.id),
      title: p.title ?? `#${p.id}`,
      url: urlFor(p),
      state: mapPrState(p),
      draft: p.draft === true,
      head: p.fromRef?.displayId ?? '',
    })),
  };
}
