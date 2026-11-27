import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_CONTROL_PROVIDER_PATH,
  createSourceControlForge,
  readSourceControlProviderRequest,
  type SourceControlForge,
  type SourceControlProviderMethod,
  type SourceControlProviderRequest,
} from '@openchamber/sdk';
import { ContextPathStore, detectContextPath, normalizeCtx } from './context-path.js';
import { apiProjectKeyOfOwner, parseRemote, readRemoteUrl, repoIdentFrom } from './remote.js';
import {
  BB,
  bbDelete,
  bbDo,
  bbGetJson,
  bbPostJson,
  bbPutJson,
  collectPages,
  parseJsonLoose,
  type BbActivity,
  type BbBuildStats,
  type BbBuildStatus,
  type BbChange,
  type BbCommit,
  type BbMergeability,
  type BbPage,
  type BbPullRequest,
  type BbPullRequestSettings,
  type BbRepo,
  type BbUser,
} from './bitbucket.js';
import {
  assessMerge,
  buildSubmitRequirements,
  computeStack,
  mapActivitiesToComments,
  mapChangedFiles,
  mapCiRuns,
  mapCiStats,
  mapCommit,
  mapForgeUser,
  mapPrState,
  mapProject,
  mapPull,
  mapReviewers,
  mapVerdicts,
  splitUnifiedDiff,
  webPrUrl,
} from './mappers.js';
import { CallError, type CallCtx, type DtoProject, type RepoIdent } from './types.js';

const PAGE_SIZE = 25;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function repoApiPath(ctx: string, key: string, slug: string): string {
  return `${ctx}/rest/api/latest/projects/${enc(key)}/repos/${enc(slug)}`;
}

function selectorOf(value: unknown): { id?: string; owner?: string; name?: string; repo?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const owner = typeof obj.owner === 'string' ? obj.owner : undefined;
  const name = typeof obj.name === 'string' ? obj.name : typeof obj.repo === 'string' ? obj.repo : undefined;
  const id = typeof obj.id === 'string' ? obj.id : undefined;
  return owner && name ? { id, owner, name } : null;
}

function isLinkedRead(input: Record<string, unknown>): boolean {
  if (input.linked === true) return true;
  if (!input.context || typeof input.context !== 'object' || Array.isArray(input.context)) return false;
  return (input.context as Record<string, unknown>).linked === true;
}

async function fetchRepo(bb: BB, ident: RepoIdent): Promise<{ repo: BbRepo; apiKey: string }> {
  const tryKey = async (key: string) => {
    const repo = await bbGetJson<BbRepo>(bb, repoApiPath(bb.ctx, key, ident.repo));
    if (typeof repo.id !== 'number' || typeof repo.slug !== 'string') {
      throw new CallError('Bitbucket returned an invalid repository payload.', 'MALFORMED_REPO', 502);
    }
    return { repo, apiKey: repo.project?.key ?? key };
  };
  try {
    return await tryKey(ident.apiKey);
  } catch (err) {
    if (!(err instanceof CallError) || err.status !== 404) throw err;
    const alt = ident.apiKey.startsWith('~') ? ident.apiKey.slice(1) : `~${ident.apiKey}`;
    try {
      return await tryKey(alt);
    } catch {
      throw err;
    }
  }
}

async function fetchDefaultBranch(bb: BB, key: string, slug: string): Promise<string | null> {
  try {
    const db = await bbGetJson<{ displayId?: string }>(bb, `${repoApiPath(bb.ctx, key, slug)}/default-branch`);
    return typeof db.displayId === 'string' && db.displayId ? db.displayId : null;
  } catch (err) {
    if (err instanceof CallError && err.status === 404) return null;
    throw err;
  }
}

type ResolvedRepo = {
  bb: BB;
  ident: RepoIdent;
  raw: BbRepo;
  apiKey: string;
  project: DtoProject;
  defaultBranch: string | null;
};

async function resolveBoundRepo(
  call: CallCtx,
  input: Record<string, unknown>,
  explicitSelector?: { id?: string; owner?: string; name?: string; repo?: string } | null,
  opts: { includeDefaultBranch?: boolean; allowLinked?: boolean } = {},
): Promise<ResolvedRepo> {
  const { includeDefaultBranch = false, allowLinked = false } = opts;
  const directory = typeof input.directory === 'string' ? input.directory : '';
  const remoteName = typeof input.remote === 'string' && input.remote ? input.remote : 'origin';

  if (allowLinked && explicitSelector && isLinkedRead(input)) {
    const wantedOwner = (explicitSelector.owner ?? '').trim();
    const wantedKey = apiProjectKeyOfOwner(wantedOwner);
    const wantedSlug = (explicitSelector.name ?? explicitSelector.repo ?? '').trim();
    if (!wantedKey || !wantedSlug) {
      throw new CallError('Invalid repository selector.', 'BAD_REQUEST', 400);
    }
    let ctxHint: string | null = null;
    if (directory && store.get(call.origin) === undefined) {
      try {
        ctxHint = parseRemote(await readRemoteUrl(directory, remoteName), call.originUrl).ctxHint;
      } catch {
        ctxHint = null;
      }
    }
    const det = await detectContextPath({
      store,
      forge: call.forge,
      handle: call.handle,
      origin: call.origin,
      hint: ctxHint,
    });
    call.ctx = det.ctx;
    const bb = new BB(det.ctx, call.handle, call.forge);
    const linkedIdent: RepoIdent = {
      dtoOwner: wantedOwner,
      repo: wantedSlug,
      apiKey: wantedKey,
    };
    const linkedGot = await fetchRepo(bb, linkedIdent);
    const linkedDefault = includeDefaultBranch
      ? await fetchDefaultBranch(bb, linkedGot.apiKey, linkedGot.repo.slug)
      : null;
    return {
      bb,
      ident: linkedIdent,
      raw: linkedGot.repo,
      apiKey: linkedGot.apiKey,
      project: mapProject(call, linkedGot.repo, wantedOwner, { defaultBranch: linkedDefault }),
      defaultBranch: linkedDefault,
    };
  }

  const rawRemote = await readRemoteUrl(directory, remoteName);
  const parsed = parseRemote(rawRemote, call.originUrl);

  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
    hint: parsed.ctxHint,
  });
  call.ctx = det.ctx;
  const bb = new BB(det.ctx, call.handle, call.forge);

  const primaryIdent = repoIdentFrom(null, parsed, remoteName);
  const primaryGot = await fetchRepo(bb, primaryIdent);
  const defaultBranch = includeDefaultBranch
    ? await fetchDefaultBranch(bb, primaryGot.apiKey, primaryGot.repo.slug)
    : null;
  const primaryProject = mapProject(call, primaryGot.repo, primaryIdent.dtoOwner, {
    defaultBranch,
    remoteName,
  });

  if (!explicitSelector) {
    return {
      bb,
      ident: primaryIdent,
      raw: primaryGot.repo,
      apiKey: primaryGot.apiKey,
      project: primaryProject,
      defaultBranch,
    };
  }

  const wantedKey = apiProjectKeyOfOwner(explicitSelector.owner ?? '');
  const wantedSlug = explicitSelector.name ?? explicitSelector.repo ?? '';
  const isPersonalRepo = primaryGot.apiKey.startsWith('~') || primaryGot.repo.project?.type === 'PERSONAL';
  const sameKey = isPersonalRepo
    ? wantedKey.replace(/^~/, '').toLowerCase() === primaryGot.apiKey.replace(/^~/, '').toLowerCase()
    : wantedKey.toLowerCase() === primaryGot.apiKey.toLowerCase();
  if (sameKey && wantedSlug.toLowerCase() === primaryGot.repo.slug.toLowerCase()) {
    const project = mapProject(call, primaryGot.repo, explicitSelector.owner ?? primaryIdent.dtoOwner, {
      defaultBranch,
    });
    return {
      bb,
      ident: { ...primaryIdent, dtoOwner: project.owner },
      raw: primaryGot.repo,
      apiKey: primaryGot.apiKey,
      project,
      defaultBranch,
    };
  }

  const originRepo = primaryGot.repo.origin;
  if (
    originRepo &&
    originRepo.project?.key?.toLowerCase() === wantedKey.toLowerCase() &&
    originRepo.slug?.toLowerCase() === wantedSlug.toLowerCase()
  ) {
    const upstreamIdent: RepoIdent = {
      dtoOwner: explicitSelector.owner ?? originRepo.project.key,
      repo: originRepo.slug,
      apiKey: originRepo.project.key,
    };
    const upstreamGot = await fetchRepo(bb, upstreamIdent);
    const upDefault = includeDefaultBranch
      ? await fetchDefaultBranch(bb, upstreamGot.apiKey, upstreamGot.repo.slug)
      : null;
    return {
      bb,
      ident: upstreamIdent,
      raw: upstreamGot.repo,
      apiKey: upstreamGot.apiKey,
      project: mapProject(call, upstreamGot.repo, upstreamIdent.dtoOwner, { defaultBranch: upDefault }),
      defaultBranch: upDefault,
    };
  }

  throw new CallError(
    `Repository "${wantedKey}/${wantedSlug}" is outside the bound repository network.`,
    'NOT_IN_NETWORK',
    404,
  );
}

async function fetchPr(bb: BB, key: string, slug: string, number: number): Promise<BbPullRequest> {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CallError('Pull request number must be a positive integer.', 'BAD_REQUEST', 400);
  }
  const pr = await bbGetJson<BbPullRequest>(bb, `${repoApiPath(bb.ctx, key, slug)}/pull-requests/${number}`, {
    withProperties: 'true',
  });
  if (typeof pr.id !== 'number' || typeof pr.version !== 'number') {
    throw new CallError('Bitbucket returned an invalid pull request payload.', 'MALFORMED_PR', 502);
  }
  return pr;
}

async function fetchMergeability(bb: BB, key: string, slug: string, number: number): Promise<BbMergeability | null> {
  try {
    return await bbGetJson<BbMergeability>(bb, `${repoApiPath(bb.ctx, key, slug)}/pull-requests/${number}/merge`);
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
    return null;
  }
}

async function fetchCiFast(bb: BB, sha: string | undefined) {
  if (!sha) return null;
  try {
    const stats = await bbGetJson<BbBuildStats>(bb, `${bb.ctx}/rest/build-status/latest/commits/stats/${enc(sha)}`);
    const mapped = mapCiStats(stats);
    if (mapped) return { summary: mapped };
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
  }
  try {
    const runs = await bbGetJson<BbPage<BbBuildStatus>>(bb, `${bb.ctx}/rest/build-status/latest/commits/${enc(sha)}`, {
      limit: '50',
    });
    const mapped = mapCiRuns(Array.isArray(runs.values) ? runs.values : [], { provider: '', instance: '' });
    return mapped ? { summary: mapped.summary } : null;
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
    return null;
  }
}

async function fetchCiDetailed(call: CallCtx, bb: BB, sha: string | undefined) {
  if (!sha) return null;
  try {
    const page = await bbGetJson<BbPage<BbBuildStatus>>(bb, `${bb.ctx}/rest/build-status/latest/commits/${enc(sha)}`, {
      limit: '50',
    });
    const values = Array.isArray(page.values) ? page.values : [];
    const detailed = mapCiRuns(values, call.identity);
    if (detailed) return detailed;
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
  }
  const fast = await fetchCiFast(bb, sha);
  return fast ? { summary: fast.summary, runs: [] } : null;
}

async function fetchDiffText(bb: BB, key: string, slug: string, number: number): Promise<string> {
  const res = await bbDo(bb, 'GET', `${repoApiPath(bb.ctx, key, slug)}/pull-requests/${number}.diff`, {
    query: { contextLines: '3' },
    headers: { accept: 'text/plain' },
  });
  if (res.status === 401) throw new CallError('Unauthorized', 'UNAUTHORIZED', 401);
  if (res.status === 404) throw new CallError(`Pull request #${number} was not found.`, 'NOT_FOUND', 404);
  if (res.status < 200 || res.status >= 300) {
    throw new CallError(`Bitbucket answered HTTP ${res.status} on pull request diff.`, 'FORGE_ERROR', res.status);
  }
  return res.body;
}

async function findUserByIdentifier(bb: BB, who: string): Promise<BbUser | null> {
  try {
    const page = await bbGetJson<BbPage<BbUser>>(bb, bb.rest('/users'), { filter: who, limit: '25' });
    const values = Array.isArray(page.values) ? page.values : [];
    const exact = values.find((u) => u.name === who || u.slug === who);
    if (exact) return exact;
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
  }
  try {
    return await bbGetJson<BbUser>(bb, bb.rest(`/users/${enc(who)}`));
  } catch (err) {
    if (err instanceof CallError && err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async function hAuthProbe(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
    forceProbe: true,
  });
  if (det.basis === 'none') {
    return { supported: false, message: 'No Bitbucket Data Center API found at this origin.' };
  }
  const version = typeof det.props?.version === 'string' && det.props.version ? det.props.version : undefined;
  return version ? { supported: true, version } : { supported: true };
}

async function hAuthVerify(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
    forceProbe: true,
  });
  if (det.basis === 'none') {
    throw new CallError('No Bitbucket Data Center API found at this origin.', 'NOT_BITBUCKET', 400);
  }
  const bb = new BB(det.ctx, call.handle, call.forge);

  // Step 1: hit an auth-gated endpoint so an invalid token records a real 401 on the outbound handle.
  await bbGetJson(bb, bb.rest('/inbox/pull-requests/count'));

  // Step 2: read authenticated username from applinks/whoami body.
  let whoami: string | null = null;
  const whoRes = await bbDo(bb, 'GET', `${bb.ctx}/plugins/servlet/applinks/whoami`, {
    headers: { accept: 'text/plain' },
  });
  if (whoRes.status === 401) throw new CallError('Invalid access token.', 'UNAUTHORIZED', 401);
  if (whoRes.status === 200) whoami = whoRes.body.trim() || null;

  let user: BbUser | null = whoami ? await findUserByIdentifier(bb, whoami) : null;
  if (!user) {
    const dash = await bbGetJson<BbPage<BbPullRequest>>(bb, bb.rest('/dashboard/pull-requests'), {
      role: 'AUTHOR',
      limit: '1',
    });
    user = Array.isArray(dash.values) ? (dash.values[0]?.author?.user ?? null) : null;
  }
  const mapped = mapForgeUser(user);
  if (!mapped) {
    throw new CallError('Could not resolve the Bitbucket user for this token.', 'USER_NOT_FOUND', 502);
  }
  return { user: mapped };
}

async function hUnsupported(_req: SourceControlProviderRequest): Promise<never> {
  throw new CallError('This operation is not supported for Bitbucket Data Center.', 'UNSUPPORTED', 501);
}

// ---------------------------------------------------------------------------
// Resource read handlers
// ---------------------------------------------------------------------------

async function hChangeRequestStatus(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const branch = String(input.branch ?? '');
  const remoteName = typeof input.remote === 'string' && input.remote ? input.remote : null;
  const { bb, raw, apiKey, project, defaultBranch } = await resolveBoundRepo(call, input, null, {
    includeDefaultBranch: true,
  });

  if (!branch.trim()) {
    return {
      identity: call.identity,
      fetchedAt: Date.now(),
      project,
      branch,
      changeRequest: null,
      ci: null,
      defaultBranch,
      resolvedRemoteName: remoteName,
      stack: null,
    };
  }

  const prPath = `${repoApiPath(bb.ctx, apiKey, raw.slug)}/pull-requests`;
  const outgoing = await bbGetJson<BbPage<BbPullRequest>>(bb, prPath, {
    at: `refs/heads/${branch}`,
    direction: 'OUTGOING',
    state: 'ALL',
    limit: '50',
  });
  const candidates = (Array.isArray(outgoing.values) ? outgoing.values : []).filter(
    (pr) => pr.fromRef?.id === `refs/heads/${branch}` && pr.fromRef?.repository?.id === raw.id,
  );
  const picked =
    candidates.find((pr) => mapPrState(pr) === 'open') ??
    candidates.slice().sort((a, b) => (b.updatedDate ?? 0) - (a.updatedDate ?? 0))[0] ??
    null;

  if (!picked) {
    return {
      identity: call.identity,
      fetchedAt: Date.now(),
      project,
      branch,
      changeRequest: null,
      ci: null,
      defaultBranch,
      resolvedRemoteName: remoteName,
      stack: null,
    };
  }

  const state = mapPrState(picked);
  const mergeInfo = state === 'open' ? await fetchMergeability(bb, apiKey, raw.slug, picked.id) : null;
  const assessment = state === 'open' ? assessMerge(picked.draft === true, mergeInfo) : undefined;
  const ci = state === 'open' ? await fetchCiFast(bb, picked.fromRef?.latestCommit) : null;

  let stack = null;
  if (state === 'open') {
    const openRes = await collectPages<BbPullRequest>(bb, prPath, { state: 'OPEN', limit: '50' }, 5);
    stack = computeStack(picked, openRes.items, raw.id, (p) =>
      p.links?.self?.[0]?.href?.replace(/\/overview\/?$/, '') ??
      webPrUrl(call.origin, bb.ctx, apiKey, raw.slug, p.id),
    );
  }

  return {
    identity: call.identity,
    fetchedAt: Date.now(),
    project,
    branch,
    changeRequest: mapPull(call, picked, project, assessment),
    ci,
    ...(state === 'open' && assessment ? { canMerge: assessment.canMerge } : {}),
    defaultBranch,
    resolvedRemoteName: remoteName,
    stack,
  };
}

async function hListChangeRequests(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, input);
  const login = call.user?.login ?? '';
  const stateMap: Record<string, string> = { open: 'OPEN', closed: 'DECLINED', merged: 'MERGED', all: 'ALL' };
  const params: Record<string, string> = {
    state: stateMap[String(input.state ?? 'open')] ?? 'OPEN',
    limit: String(PAGE_SIZE),
    withProperties: 'false',
    withAttributes: 'false',
  };
  if (typeof input.query === 'string' && input.query.trim()) {
    params.filterText = input.query.trim();
  }
  const people = String(input.people ?? 'any');
  if (people === 'created' && login) {
    params['username.1'] = login;
    params['role.1'] = 'AUTHOR';
  } else if (people === 'reviewRequested' && login) {
    params['username.1'] = login;
    params['role.1'] = 'REVIEWER';
  }

  const rawPage = Number(input.page ?? 1);
  const wantedPage = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const MAX_LIST_PAGES = 50;
  if (wantedPage > MAX_LIST_PAGES) {
    return { items: [], page: wantedPage, hasMore: false };
  }
  const listPath = `${repoApiPath(bb.ctx, apiKey, raw.slug)}/pull-requests`;
  let start = 0;
  let last: BbPage<BbPullRequest> = { values: [], isLastPage: true };
  for (let p = 1; p <= wantedPage; p++) {
    last = await bbGetJson<BbPage<BbPullRequest>>(bb, listPath, { ...params, start: String(start) });
    if (p < wantedPage) {
      if (last.isLastPage !== false || typeof last.nextPageStart !== 'number') {
        return { items: [], page: wantedPage, hasMore: false };
      }
      start = last.nextPageStart;
    }
  }
  const values = Array.isArray(last.values) ? last.values : [];
  const items = values.map((pr) => {
    const headRepo = pr.fromRef?.repository;
    const isFork = headRepo && typeof headRepo.id === 'number' && headRepo.id !== raw.id;
    const headProject = isFork ? mapProject(call, headRepo, headRepo.project?.key ?? project.owner) : null;
    return mapPull(call, pr, project, undefined, headProject);
  });
  return { items, page: wantedPage, hasMore: last.isLastPage === false };
}

async function hChangeRequestContext(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const selector = selectorOf(input.project);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, input, selector, { allowLinked: true });
  const number = Number(input.number ?? 0);
  const includeDiff = input.includeDiff === true;
  const includeTimeline = input.includeTimeline === true;
  const includeCIDetails = input.includeCIDetails === true;

  const pr = await fetchPr(bb, apiKey, raw.slug, number);
  const state = mapPrState(pr);
  const isOpen = state === 'open';
  const headSha = pr.fromRef?.latestCommit;
  const repoBase = repoApiPath(bb.ctx, apiKey, raw.slug);

  const [mergeInfo, activitiesRes, diffText, changesRes, ci, commitsRes, openPrsRes] = await Promise.all([
    isOpen ? fetchMergeability(bb, apiKey, raw.slug, number) : Promise.resolve(null),
    collectPages<BbActivity>(bb, `${repoBase}/pull-requests/${number}/activities`, { limit: '100' }),
    includeDiff ? fetchDiffText(bb, apiKey, raw.slug, number) : Promise.resolve(''),
    includeDiff
      ? bbGetJson<BbPage<BbChange>>(bb, `${repoBase}/pull-requests/${number}/changes`, {
          changeScope: 'ALL',
          withComments: 'false',
          limit: '1000',
        })
      : Promise.resolve({ values: [] as BbChange[] }),
    includeCIDetails ? fetchCiDetailed(call, bb, headSha) : fetchCiFast(bb, headSha),
    includeTimeline
      ? bbGetJson<BbPage<BbCommit>>(bb, `${repoBase}/pull-requests/${number}/commits`, { limit: '50' })
      : Promise.resolve(null),
    isOpen
      ? collectPages<BbPullRequest>(bb, `${repoBase}/pull-requests`, { state: 'OPEN', limit: '50' }, 5).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);

  const assessment = isOpen ? assessMerge(pr.draft === true, mergeInfo) : undefined;
  const headRepo = pr.fromRef?.repository;
  const headProject =
    headRepo && typeof headRepo.id === 'number' && headRepo.id !== raw.id
      ? mapProject(call, headRepo, headRepo.project?.key ?? project.owner)
      : null;

  const changeRequest = mapPull(call, pr, project, assessment, headProject);
  const prUrl = String(changeRequest.url);
  const { issueComments, reviewComments } = mapActivitiesToComments(
    activitiesRes.items,
    call.identity,
    prUrl,
    call.user?.login ?? null,
  );

  const patches = splitUnifiedDiff(diffText);
  const files = includeDiff
    ? mapChangedFiles(Array.isArray(changesRes.values) ? changesRes.values : [], patches)
    : [];

  const submitRequirements = isOpen
    ? buildSubmitRequirements(assessment, pr.properties?.openTaskCount)
    : [];

  const stack =
    isOpen && openPrsRes
      ? computeStack(pr, openPrsRes.items, raw.id, (p) =>
          p.links?.self?.[0]?.href?.replace(/\/overview\/?$/, '') ??
          webPrUrl(call.origin, bb.ctx, apiKey, raw.slug, p.id),
        )
      : null;

  const out: Record<string, unknown> = {
    identity: call.identity,
    project,
    changeRequest,
    issueComments,
    reviewComments,
    files,
    diff: diffText,
    ci,
    submitRequirements,
  };
  if (stack) out.stack = stack;

  if (includeTimeline && commitsRes) {
    const rawCommits = Array.isArray(commitsRes.values) ? commitsRes.values : [];
    out.commits = rawCommits
      .map((c) => mapCommit(c, call.origin, bb.ctx, apiKey, raw.slug))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .reverse();
    out.commitsComplete = commitsRes.isLastPage !== false;
    out.reviewers = mapReviewers(pr, call.identity);
    out.verdicts = mapVerdicts(pr, call.identity, prUrl);
  }

  return out;
}

async function hProjectUpstream(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const { bb, raw } = await resolveBoundRepo(call, req.input);
  const originRepo = raw.origin;
  if (!originRepo || typeof originRepo.slug !== 'string' || !originRepo.project?.key) {
    return { identity: call.identity, isFork: false, upstream: null };
  }
  const upIdent: RepoIdent = {
    dtoOwner: originRepo.project.key,
    repo: originRepo.slug,
    apiKey: originRepo.project.key,
  };
  const upGot = await fetchRepo(bb, upIdent);
  const defaultBranch = await fetchDefaultBranch(bb, upGot.apiKey, upGot.repo.slug);
  return {
    identity: call.identity,
    isFork: true,
    upstream: mapProject(call, upGot.repo, upGot.apiKey, { defaultBranch }),
  };
}

async function hProjectBranches(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const selector = selectorOf(req.input.project);
  const { bb, raw, apiKey } = await resolveBoundRepo(call, req.input, selector);
  const { items } = await collectPages<{ displayId?: string }>(
    bb,
    `${repoApiPath(bb.ctx, apiKey, raw.slug)}/branches`,
    { orderBy: 'MODIFICATION', limit: '100' },
    5,
  );
  return items.map((b) => b.displayId ?? '').filter(Boolean);
}

async function hListReviewerCandidates(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const selector = selectorOf(req.input.project);
  const { bb, raw, apiKey } = await resolveBoundRepo(call, req.input, selector);
  const page = await bbGetJson<BbPage<BbUser>>(bb, bb.rest('/users'), {
    'permission.1': 'REPO_READ',
    'permission.1.projectKey': apiKey,
    'permission.1.repositorySlug': raw.slug,
    limit: '100',
  });
  const values = Array.isArray(page.values) ? page.values : [];
  return values
    .filter((u) => u.active !== false && u.type !== 'SERVICE')
    .map((u) => {
      const f = mapForgeUser(u);
      if (!f) return null;
      return f.avatarUrl
        ? { id: String(f.id), login: f.login, avatarUrl: f.avatarUrl }
        : { id: String(f.id), login: f.login };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);
}

async function hReadChangeRequestPatch(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const selector = selectorOf(req.input.sourceRepo);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, req.input, selector, { allowLinked: true });
  const number = Number(req.input.number ?? 0);
  const patch = await fetchDiffText(bb, apiKey, raw.slug, number);
  return { patch, meta: { owner: project.owner, repo: project.name, number } };
}

function encodeFileSegments(filePath: string): string {
  const segs = filePath.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) {
    throw new CallError(`Invalid file path "${filePath}".`, 'BAD_REQUEST', 400);
  }
  return segs.map(enc).join('/');
}

async function hReadChangeRequestFile(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const selector = selectorOf(input.sourceRepo);
  const { bb, raw, apiKey } = await resolveBoundRepo(call, input, selector, { allowLinked: true });
  const number = Number(input.number ?? 0);
  const pr = await fetchPr(bb, apiKey, raw.slug, number);

  const headSha = pr.fromRef?.latestCommit ?? '';
  const toSha = pr.toRef?.latestCommit ?? '';
  if (!COMMIT_SHA.test(headSha) || !COMMIT_SHA.test(toSha)) {
    throw new CallError('Bitbucket returned invalid pull request commit SHAs.', 'MALFORMED_PR', 502);
  }

  const srcKey = pr.fromRef?.repository?.project?.key ?? apiKey;
  const srcSlug = pr.fromRef?.repository?.slug ?? raw.slug;
  const sameRepo = (pr.fromRef?.repository?.id ?? raw.id) === raw.id;

  let baseSha = toSha;
  const mbRepos: Array<[string, string]> = sameRepo
    ? [[apiKey, raw.slug]]
    : [
        [srcKey, srcSlug],
        [apiKey, raw.slug],
      ];
  for (const [mbKey, mbSlug] of mbRepos) {
    try {
      const mbRes = await bbDo(bb, 'GET', `${repoApiPath(bb.ctx, mbKey, mbSlug)}/commits/${enc(headSha)}/merge-base`, {
        query: { otherCommitId: toSha },
        headers: { accept: 'application/json' },
      });
      if (mbRes.status === 401) throw new CallError('Unauthorized', 'UNAUTHORIZED', 401);
      if (mbRes.status === 200 && mbRes.body) {
        const parsed = parseJsonLoose(mbRes.body) as { id?: unknown } | null;
        if (parsed && typeof parsed.id === 'string' && COMMIT_SHA.test(parsed.id)) {
          baseSha = parsed.id;
          break;
        }
      }
    } catch (err) {
      if (err instanceof CallError && err.status === 401) throw err;
    }
  }

  const readRaw = async (repoKey: string, repoSlug: string, filePath: string, atSha: string): Promise<string> => {
    const res = await bbDo(bb, 'GET', `${repoApiPath(bb.ctx, repoKey, repoSlug)}/raw/${encodeFileSegments(filePath)}`, {
      query: { at: atSha },
      headers: { accept: 'text/plain' },
    });
    if (res.status === 200) return res.body;
    if (res.status === 404) return '';
    if (res.status === 401) throw new CallError('Unauthorized', 'UNAUTHORIZED', 401);
    throw new CallError(`Bitbucket answered HTTP ${res.status} reading raw file.`, 'FORGE_ERROR', res.status);
  };

  const filePath = String(input.path ?? '');
  const previousPath = typeof input.previousPath === 'string' && input.previousPath ? input.previousPath : filePath;
  const status = String(input.status ?? 'M').toUpperCase();

  const [original, modified] = await Promise.all([
    status === 'A' ? Promise.resolve('') : readRaw(apiKey, raw.slug, previousPath, baseSha),
    status === 'D' ? Promise.resolve('') : readRaw(srcKey, srcSlug, filePath, headSha),
  ]);
  return { original, modified };
}

async function hLiveSummaries(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
  });
  const bb = new BB(det.ctx, call.handle, call.forge);
  const refs = Array.isArray(req.input.refs)
    ? (req.input.refs as Array<{ owner?: unknown; repo?: unknown; number?: unknown }>)
    : [];

  const rows = await Promise.all(
    refs.map(async (ref) => {
      const owner = typeof ref.owner === 'string' ? ref.owner : '';
      const repo = typeof ref.repo === 'string' ? ref.repo : '';
      const number = Number(ref.number ?? 0);
      if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) return null;
      const keyCandidates = [apiProjectKeyOfOwner(owner)];
      if (!keyCandidates[0].startsWith('~')) keyCandidates.push(`~${keyCandidates[0]}`);
      try {
        let pr: BbPullRequest | null = null;
        let usedKey = keyCandidates[0];
        for (const candidateKey of keyCandidates) {
          try {
            pr = await fetchPr(bb, candidateKey, repo, number);
            usedKey = candidateKey;
            break;
          } catch (err) {
            if (err instanceof CallError && err.status === 404) continue;
            throw err;
          }
        }
        if (!pr) return null;
        const state = mapPrState(pr);
        const isOpen = state === 'open';
        const [mergeInfo, ci] = isOpen
          ? await Promise.all([
              fetchMergeability(bb, usedKey, repo, number),
              fetchCiFast(bb, pr.fromRef?.latestCommit),
            ])
          : [null, null];
        const assessment = isOpen ? assessMerge(pr.draft === true, mergeInfo) : null;
        return {
          owner,
          repo,
          number: Number(pr.id),
          state,
          draft: pr.draft === true,
          title: pr.title ?? '',
          mergeable: assessment ? assessment.mergeable : null,
          mergeableState: assessment ? assessment.mergeableState : null,
          checks: isOpen && ci ? ci.summary : null,
          ...(pr.fromRef?.latestCommit ? { headSha: pr.fromRef.latestCommit } : {}),
          ...(pr.toRef?.displayId ? { base: pr.toRef.displayId } : {}),
        };
      } catch (err) {
        if (err instanceof CallError && err.status === 401) throw err;
        return null;
      }
    }),
  );

  return {
    summaries: rows.filter((r): r is NonNullable<typeof r> => r !== null),
    issueSummaries: [],
  };
}

async function hReadChangeRequestHead(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, req.input);
  const pr = await fetchPr(bb, apiKey, raw.slug, Number(req.input.number ?? 0));
  const headSha = (pr.fromRef?.latestCommit ?? '').toLowerCase();
  if (!COMMIT_SHA.test(headSha)) {
    throw new CallError('Bitbucket did not report a valid 40-char head commit SHA.', 'HEAD_SHA_MISSING', 502);
  }
  const sameRepo = (pr.fromRef?.repository?.id ?? raw.id) === raw.id;
  const headOwner = sameRepo ? project.owner : (pr.fromRef?.repository?.project?.key ?? project.owner);
  return {
    project: { id: project.id, owner: project.owner, name: project.name },
    headSha,
    headBranch: pr.fromRef?.displayId ?? '',
    headOwner,
  };
}

function normalizeCloneEndpointOnInstance(
  rawCloneUrl: string | undefined,
  instanceOrigin: string,
): { endpoint: string; owner: string; name: string } | null {
  if (!rawCloneUrl) return null;
  try {
    const parsed = new URL(rawCloneUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const clean = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    const slash = clean.lastIndexOf('/');
    if (slash <= 0) return null;
    const owner = clean.slice(0, slash);
    const name = clean.slice(slash + 1);
    if (!owner || !name) return null;
    const target = new URL(instanceOrigin);
    target.pathname = parsed.pathname.endsWith('.git') ? parsed.pathname : `${parsed.pathname.replace(/\/+$/, '')}.git`;
    target.search = '';
    target.hash = '';
    return { endpoint: target.href, owner, name };
  } catch {
    return null;
  }
}

async function hResolveChangeRequestSource(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const targetSel = selectorOf(input.project);
  if (!targetSel) throw new CallError('Target project is required.', 'BAD_REQUEST', 400);
  const { bb, raw, apiKey, project: targetProject } = await resolveBoundRepo(call, input, targetSel);
  const pr = await fetchPr(bb, apiKey, raw.slug, Number(input.number ?? 0));

  const actualSha = (pr.fromRef?.latestCommit ?? '').toLowerCase();
  const expectedSha = String(input.expectedHeadSha ?? '').toLowerCase();
  if (!COMMIT_SHA.test(actualSha)) {
    throw new CallError('Bitbucket did not report a valid head commit SHA.', 'HEAD_SHA_MISSING', 502);
  }
  if (expectedSha && actualSha !== expectedSha) {
    throw new CallError('The pull request head commit changed.', 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', 409);
  }

  const srcRefRepo = pr.fromRef?.repository;
  const srcKey = srcRefRepo?.project?.key ?? apiKey;
  const srcSlug = srcRefRepo?.slug ?? raw.slug;
  const sameRepo = (srcRefRepo?.id ?? raw.id) === raw.id;

  let rawHttpClone = srcRefRepo?.links?.clone?.find((c) => (c.name ?? '').toLowerCase() === 'http')?.href;
  let srcRepoId = srcRefRepo?.id ?? raw.id;
  if (!rawHttpClone) {
    const fullSrc = sameRepo ? raw : (await fetchRepo(bb, { dtoOwner: srcKey, repo: srcSlug, apiKey: srcKey })).repo;
    srcRepoId = fullSrc.id;
    rawHttpClone = fullSrc.links?.clone?.find((c) => (c.name ?? '').toLowerCase() === 'http')?.href;
  }
  const fallbackClone = `${call.origin}${bb.ctx}/scm/${enc(srcKey.toLowerCase())}/${enc(srcSlug)}.git`;
  const normalized =
    normalizeCloneEndpointOnInstance(rawHttpClone, call.origin) ??
    normalizeCloneEndpointOnInstance(fallbackClone, call.origin);
  if (!normalized) {
    throw new CallError('Bitbucket reported an invalid HTTPS clone URL for the source repository.', 'MALFORMED_REPO', 502);
  }

  return {
    sourceProject: {
      id: String(srcRepoId),
      owner: normalized.owner,
      name: normalized.name,
    },
    targetProject: {
      id: targetProject.id,
      owner: targetSel.owner ?? targetProject.owner,
      name: targetSel.name ?? targetProject.name,
    },
    classification: sameRepo ? 'same-repository' : 'contributor-fork',
    headSha: actualSha,
    headRef: pr.fromRef?.id ?? `refs/heads/${pr.fromRef?.displayId ?? ''}`,
    endpoint: normalized.endpoint,
  };
}

// ---------------------------------------------------------------------------
// Mutations: resolveTarget, perform, reconcile
// ---------------------------------------------------------------------------

type ProviderTarget = {
  ctx: string;
  repoId: number;
  key: string;
  slug: string;
  dtoOwner: string;
  number?: number;
  sourceRepoId?: number;
  sourceKey?: string;
  sourceSlug?: string;
};

function readProviderTarget(input: Record<string, unknown>): {
  pt: ProviderTarget;
  target: Record<string, unknown>;
} {
  const resolved = (input.resolved ?? {}) as Record<string, unknown>;
  const rawPt = (resolved.providerTarget ?? {}) as Record<string, unknown>;
  const target = (resolved.target ?? {}) as Record<string, unknown>;
  const key = typeof rawPt.key === 'string' ? rawPt.key : '';
  const slug = typeof rawPt.slug === 'string' ? rawPt.slug : '';
  if (!key || !slug) {
    throw new CallError('Resolved mutation target is missing repository coordinates.', 'BAD_REQUEST', 400);
  }
  return {
    pt: {
      ctx: typeof rawPt.ctx === 'string' ? normalizeCtx(rawPt.ctx) : '',
      repoId: Number(rawPt.repoId ?? 0),
      key,
      slug,
      dtoOwner: typeof rawPt.dtoOwner === 'string' ? rawPt.dtoOwner : key,
      number: typeof rawPt.number === 'number' ? rawPt.number : undefined,
      sourceRepoId: typeof rawPt.sourceRepoId === 'number' ? rawPt.sourceRepoId : undefined,
      sourceKey: typeof rawPt.sourceKey === 'string' ? rawPt.sourceKey : undefined,
      sourceSlug: typeof rawPt.sourceSlug === 'string' ? rawPt.sourceSlug : undefined,
    },
    target,
  };
}

async function hMutationResolveTarget(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const context = (input.context ?? {}) as Record<string, unknown>;
  const expected = ((context.target ?? {}) as Record<string, unknown>);
  const normalized = ((input.input ?? {}) as Record<string, unknown>);
  const replayOf = input.replayOf && typeof input.replayOf === 'object' ? (input.replayOf as Record<string, unknown>) : null;
  const kind = String(input.kind ?? '');

  const directory = typeof context.directory === 'string' ? context.directory : '';
  const primaryRemote = typeof context.primaryRemote === 'string' ? context.primaryRemote : 'origin';
  const repositoryId = typeof context.repositoryId === 'string' ? context.repositoryId : '';
  const bindingRevision = typeof context.bindingRevision === 'number' ? context.bindingRevision : 0;

  const expectedProj = selectorOf(expected.project);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(
    call,
    { directory, remote: primaryRemote, context },
    expectedProj,
  );

  const basePt: ProviderTarget = {
    ctx: bb.ctx,
    repoId: raw.id,
    key: apiKey,
    slug: raw.slug,
    dtoOwner: project.owner,
  };

  if (kind === 'change-request-create') {
    const reqRemote = typeof normalized.remote === 'string' && normalized.remote ? normalized.remote : primaryRemote;
    if (reqRemote !== primaryRemote) {
      throw new CallError(
        `Pull requests open on the bound remote "${primaryRemote}", not "${reqRemote}".`,
        'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH',
        409,
      );
    }
    const head = typeof expected.head === 'string' && expected.head ? expected.head : String(normalized.head ?? '');
    const base = typeof expected.base === 'string' && expected.base ? expected.base : String(normalized.base ?? '');
    if (!head || !base) {
      throw new CallError('Creating a pull request requires head and base branches.', 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', 400);
    }

    let sourceRepo = raw;
    let sourceKey = apiKey;
    const headRemote = typeof normalized.headRemote === 'string' && normalized.headRemote ? normalized.headRemote : primaryRemote;
    if (headRemote !== primaryRemote) {
      const headUrl = await readRemoteUrl(directory, headRemote);
      const headParsed = parseRemote(headUrl, call.originUrl);
      const headGot = await fetchRepo(bb, { dtoOwner: headParsed.dtoOwner, repo: headParsed.slug, apiKey: headParsed.projectKey });
      const inNetwork = headGot.repo.id === raw.id || headGot.repo.origin?.id === raw.id;
      if (!inNetwork) {
        throw new CallError(
          `Remote "${headRemote}" is neither "${apiKey}/${raw.slug}" nor a fork of it.`,
          'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH',
          409,
        );
      }
      sourceRepo = headGot.repo;
      sourceKey = headGot.apiKey;
    }

    return {
      providerTarget: {
        ...basePt,
        sourceRepoId: sourceRepo.id,
        sourceKey,
        sourceSlug: sourceRepo.slug,
      },
      target: {
        repositoryId,
        bindingRevision,
        primaryRemote,
        project: { id: project.id, owner: project.owner, name: project.name },
        head,
        base,
      },
    };
  }

  const replayTarget =
    replayOf?.target && typeof replayOf.target === 'object' ? (replayOf.target as Record<string, unknown>) : null;
  const number =
    (typeof replayTarget?.number === 'number' ? replayTarget.number : undefined) ??
    (typeof expected.number === 'number' ? expected.number : undefined) ??
    (typeof normalized.number === 'number' ? normalized.number : undefined);
  if (typeof number !== 'number' || number < 1) {
    throw new CallError('Target pull request number is required.', 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', 400);
  }

  if (replayTarget && Object.keys(replayTarget).length > 0) {
    return {
      providerTarget: { ...basePt, number },
      target: replayTarget,
    };
  }

  const pr = await fetchPr(bb, apiKey, raw.slug, number);
  const actualHead = pr.fromRef?.displayId ?? '';
  const actualBase = pr.toRef?.displayId ?? '';
  const actualSha = pr.fromRef?.latestCommit ?? '';
  for (const [field, actual] of [
    ['head', actualHead],
    ['base', actualBase],
    ['headSha', actualSha],
  ] as const) {
    const wanted = typeof expected[field] === 'string' ? (expected[field] as string) : '';
    if (wanted && wanted.toLowerCase() !== actual.toLowerCase()) {
      throw new CallError(
        `Pull request ${field} changed on Bitbucket.`,
        'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH',
        409,
      );
    }
  }

  const resolvedTarget: Record<string, unknown> = {
    repositoryId,
    bindingRevision,
    primaryRemote,
    project: { id: project.id, owner: project.owner, name: project.name },
    number,
    head: actualHead,
    base: actualBase,
  };
  if (actualSha) resolvedTarget.headSha = actualSha;

  return {
    providerTarget: { ...basePt, number },
    target: resolvedTarget,
  };
}

async function hMutationPerform(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const kind = String(input.kind ?? '');
  const normalized = ((input.input ?? {}) as Record<string, unknown>);
  const { pt, target } = readProviderTarget(input);
  const bb = new BB(pt.ctx, call.handle, call.forge);
  const repoBase = repoApiPath(bb.ctx, pt.key, pt.slug);

  switch (kind) {
    case 'change-request-create': {
      const head = typeof target.head === 'string' && target.head ? target.head : String(normalized.head ?? '');
      const base = typeof target.base === 'string' && target.base ? target.base : String(normalized.base ?? '');
      if (!head || !base) {
        throw new CallError('Head and base branches are required.', 'BAD_REQUEST', 400);
      }
      const targetRepoId = pt.repoId || (await fetchRepo(bb, { dtoOwner: pt.dtoOwner, repo: pt.slug, apiKey: pt.key })).repo.id;
      const sourceRepoId = pt.sourceRepoId ?? targetRepoId;
      const payload: Record<string, unknown> = {
        title: String(normalized.title ?? ''),
        draft: normalized.draft === true,
        fromRef: { id: `refs/heads/${head}`, repository: { id: sourceRepoId } },
        toRef: { id: `refs/heads/${base}`, repository: { id: targetRepoId } },
      };
      const bodyText = typeof normalized.body === 'string'
        ? normalized.body
        : typeof normalized.description === 'string'
          ? normalized.description
          : undefined;
      if (bodyText !== undefined) payload.description = bodyText;

      const created = await bbPostJson<BbPullRequest>(bb, `${repoBase}/pull-requests`, payload);
      return { number: Number(created.id) };
    }

    case 'change-request-update':
    case 'change-request-ready':
    case 'change-request-draft':
    case 'change-request-reviewers': {
      if (!pt.number) throw new CallError('Pull request number is required.', 'BAD_REQUEST', 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);

      const nextTitle = typeof normalized.title === 'string' ? normalized.title : (pr.title ?? '');
      const hasBody = Object.hasOwn(normalized, 'body') || Object.hasOwn(normalized, 'description');
      const nextDescription = hasBody
        ? String(normalized.body ?? normalized.description ?? '')
        : (pr.description ?? '');
      const nextDraft =
        kind === 'change-request-ready'
          ? false
          : kind === 'change-request-draft'
            ? true
            : pr.draft === true;

      const rawNames = Array.isArray(normalized.names)
        ? normalized.names
        : Array.isArray(normalized.reviewers)
          ? normalized.reviewers
          : null;
      const nextReviewers =
        kind === 'change-request-reviewers' && rawNames
          ? rawNames
              .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
              .map((name) => ({ user: { name: name.trim() } }))
          : (pr.reviewers ?? [])
              .map((r) => r.user?.name)
              .filter((n): n is string => typeof n === 'string' && n.length > 0)
              .map((name) => ({ user: { name } }));

      await bbPutJson(bb, `${repoBase}/pull-requests/${pt.number}`, {
        id: pr.id,
        version: pr.version,
        title: nextTitle,
        description: nextDescription,
        draft: nextDraft,
        toRef: pr.toRef,
        reviewers: nextReviewers,
      });

      if (kind === 'change-request-ready') return { ready: true };
      if (kind === 'change-request-draft') return { draft: true };
      return {};
    }

    case 'change-request-review': {
      if (!pt.number) throw new CallError('Pull request number is required.', 'BAD_REQUEST', 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      const me = call.user?.login ?? '';
      let viewerSlug: string | undefined;
      for (const p of [...(pr.reviewers ?? []), ...(pr.participants ?? [])]) {
        if (p.user && (p.user.name === me || p.user.slug === me)) {
          viewerSlug = p.user.slug ?? p.user.name;
          break;
        }
      }
      if (!viewerSlug && me) {
        const u = await findUserByIdentifier(bb, me);
        viewerSlug = u?.slug ?? u?.name ?? me;
      }
      if (!viewerSlug) throw new CallError('Authenticated user slug could not be determined.', 'BAD_REQUEST', 400);

      const verdict = String(normalized.verdict ?? '');
      const headSha =
        (typeof target.headSha === 'string' && target.headSha) || pr.fromRef?.latestCommit || undefined;
      await bbPutJson(bb, `${repoBase}/pull-requests/${pt.number}/participants/${enc(viewerSlug)}`, {
        status: verdict === 'approve' ? 'APPROVED' : 'NEEDS_WORK',
        ...(headSha ? { lastReviewedCommit: headSha } : {}),
      });

      let commented = false;
      if (typeof normalized.body === 'string' && normalized.body.trim().length > 0) {
        await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/comments`, { text: normalized.body });
        commented = true;
      }
      return { commented };
    }

    case 'change-request-merge': {
      if (!pt.number) throw new CallError('Pull request number is required.', 'BAD_REQUEST', 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      if (mapPrState(pr) === 'merged') return { merged: true };

      const method = String(normalized.method ?? normalized.strategy ?? 'merge');
      let strategyId: string | undefined;
      try {
        const settings = await bbGetJson<BbPullRequestSettings>(bb, `${repoBase}/settings/pull-requests`);
        const enabled = (settings.mergeConfig?.strategies ?? []).filter((s) => s.enabled !== false && s.id);
        const prefs: Record<string, string[]> = {
          merge: ['no-ff', 'ff', 'ff-only'],
          squash: ['squash', 'squash-ff-only'],
          rebase: ['rebase-no-ff', 'rebase-ff-only'],
        };
        for (const candidate of prefs[method] ?? prefs.merge) {
          const hit = enabled.find((s) => (s.id ?? '').toLowerCase() === candidate);
          if (hit?.id) {
            strategyId = hit.id;
            break;
          }
        }
        if (!strategyId && method === 'merge' && settings.mergeConfig?.defaultStrategy?.id) {
          strategyId = settings.mergeConfig.defaultStrategy.id;
        }
      } catch (err) {
        if (err instanceof CallError && err.status === 401) throw err;
      }
      const fallbackMap: Record<string, string> = {
        merge: 'no-ff',
        squash: 'squash',
        rebase: 'rebase-no-ff',
      };
      const merged = await bbPostJson<BbPullRequest>(bb, `${repoBase}/pull-requests/${pt.number}/merge`, {
        version: pr.version,
        strategyId: strategyId ?? fallbackMap[method] ?? 'no-ff',
      });
      return { merged: mapPrState(merged) === 'merged' };
    }

    case 'change-request-state': {
      if (!pt.number) throw new CallError('Pull request number is required.', 'BAD_REQUEST', 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      const want = String(normalized.state ?? '');
      if (want === 'closed') {
        await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/decline`, { version: pr.version });
      } else if (want === 'open') {
        await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/reopen`, { version: pr.version });
      } else {
        throw new CallError(`Unsupported pull request state "${want}".`, 'BAD_REQUEST', 400);
      }
      return { state: want };
    }

    case 'change-request-comment': {
      if (!pt.number) throw new CallError('Pull request number is required.', 'BAD_REQUEST', 400);
      await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/comments`, {
        text: String(normalized.body ?? ''),
      });
      return {};
    }

    case 'change-request-comment-update': {
      if (!pt.number || typeof normalized.commentId !== 'string' || !normalized.commentId) {
        throw new CallError('Pull request number and commentId are required.', 'BAD_REQUEST', 400);
      }
      const cPath = `${repoBase}/pull-requests/${pt.number}/comments/${enc(normalized.commentId)}`;
      const existing = await bbGetJson<{ id?: number; version?: number }>(bb, cPath);
      await bbPutJson(bb, cPath, {
        version: existing.version ?? 0,
        text: String(normalized.body ?? ''),
      });
      return {};
    }

    case 'change-request-comment-delete': {
      if (!pt.number || typeof normalized.commentId !== 'string' || !normalized.commentId) {
        throw new CallError('Pull request number and commentId are required.', 'BAD_REQUEST', 400);
      }
      const cPath = `${repoBase}/pull-requests/${pt.number}/comments/${enc(normalized.commentId)}`;
      const existing = await bbGetJson<{ id?: number; version?: number }>(bb, cPath);
      await bbDelete(bb, cPath, { version: String(existing.version ?? 0) });
      return {};
    }

    default:
      throw new CallError(`Unsupported mutation "${kind}".`, 'UNSUPPORTED', 501);
  }
}

const NOT_APPLIED = {
  state: 'failed' as const,
  result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' },
};

async function hMutationReconcile(req: SourceControlProviderRequest): Promise<unknown> {
  const call = makeCall(req);
  const input = req.input;
  const kind = String(input.kind ?? '');
  const normalized = ((input.input ?? {}) as Record<string, unknown>);
  const { pt, target } = readProviderTarget(input);
  const bb = new BB(pt.ctx, call.handle, call.forge);
  const repoBase = repoApiPath(bb.ctx, pt.key, pt.slug);

  if (kind === 'change-request-create') {
    const head = typeof target.head === 'string' ? target.head : '';
    const base = typeof target.base === 'string' ? target.base : '';
    if (!head || !base) return { state: 'outcome-unknown' };
    const sourceRepoId = pt.sourceRepoId ?? pt.repoId;
    const page = await bbGetJson<BbPage<BbPullRequest>>(bb, `${repoBase}/pull-requests`, {
      at: `refs/heads/${head}`,
      direction: 'OUTGOING',
      state: 'ALL',
      limit: '50',
    });
    const matches = (Array.isArray(page.values) ? page.values : []).filter(
      (p) =>
        p.fromRef?.displayId === head &&
        p.toRef?.displayId === base &&
        (!sourceRepoId || p.fromRef?.repository?.id === sourceRepoId),
    );
    return matches.length === 1
      ? { state: 'succeeded', result: { number: Number(matches[0].id) } }
      : { state: 'outcome-unknown' };
  }

  if (!pt.number) return { state: 'outcome-unknown' };
  const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);

  switch (kind) {
    case 'change-request-merge':
      return mapPrState(pr) === 'merged' ? { state: 'succeeded', result: { merged: true } } : NOT_APPLIED;

    case 'change-request-state': {
      const want = String(normalized.state ?? '');
      const actual = mapPrState(pr);
      return actual === want ? { state: 'succeeded', result: { state: actual } } : NOT_APPLIED;
    }

    case 'change-request-ready':
      return pr.draft !== true ? { state: 'succeeded', result: { ready: true } } : NOT_APPLIED;

    case 'change-request-draft':
      return pr.draft === true ? { state: 'succeeded', result: { draft: true } } : NOT_APPLIED;

    case 'change-request-update': {
      const titleOk = typeof normalized.title !== 'string' || pr.title === normalized.title;
      const hasBody = Object.hasOwn(normalized, 'body') || Object.hasOwn(normalized, 'description');
      const bodyOk = !hasBody || (pr.description ?? '') === String(normalized.body ?? normalized.description ?? '');
      return titleOk && bodyOk ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    }

    case 'change-request-reviewers': {
      const wanted = (
        Array.isArray(normalized.names)
          ? normalized.names
          : Array.isArray(normalized.reviewers)
            ? normalized.reviewers
            : []
      )
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim());
      const actual = new Set((pr.reviewers ?? []).map((r) => r.user?.name ?? r.user?.slug ?? '').filter(Boolean));
      const exact = wanted.length === actual.size && wanted.every((w) => actual.has(w));
      return exact ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    }

    case 'change-request-review': {
      const me = call.user?.login ?? '';
      const wanted = String(normalized.verdict ?? '') === 'approve' ? 'APPROVED' : 'NEEDS_WORK';
      const participant = [...(pr.reviewers ?? []), ...(pr.participants ?? [])].find(
        (p) => p.user && (p.user.name === me || p.user.slug === me),
      );
      if (participant?.status === wanted && !normalized.body) {
        return { state: 'succeeded', result: { commented: false } };
      }
      return { state: 'outcome-unknown' };
    }

    default:
      return { state: 'outcome-unknown' };
  }
}

// ---------------------------------------------------------------------------
// Loopback server & dispatch
// ---------------------------------------------------------------------------

let store = new ContextPathStore(null);
let forge: SourceControlForge | null = null;

function makeCall(req: SourceControlProviderRequest): CallCtx {
  const session = req.session;
  if (!session) throw new CallError('An active provider session is required.', 'BAD_REQUEST', 400);
  let originUrl: URL;
  try {
    originUrl = new URL(session.instance);
  } catch {
    throw new CallError(`Invalid instance URL: ${session.instance}`, 'BAD_REQUEST', 400);
  }
  if (!forge) {
    throw new CallError('Outbound forge callback is not configured.', 'FORGE_UNREACHABLE', 502);
  }
  return {
    origin: session.instance,
    originUrl,
    handle: session.handle,
    forge,
    ctx: '',
    provider: req.provider,
    identity: { provider: req.provider, instance: session.instance },
    user: session.user,
  };
}

const handlers: Record<SourceControlProviderMethod, (req: SourceControlProviderRequest) => Promise<unknown>> = {
  'auth.verify': hAuthVerify,
  'auth.probe': hAuthProbe,
  'auth.status': hUnsupported,
  changeRequestStatus: hChangeRequestStatus,
  listChangeRequests: hListChangeRequests,
  changeRequestContext: hChangeRequestContext,
  listIssues: hUnsupported,
  getIssue: hUnsupported,
  issueComments: hUnsupported,
  projectUpstream: hProjectUpstream,
  projectBranches: hProjectBranches,
  listLabels: hUnsupported,
  listReviewerCandidates: hListReviewerCandidates,
  readChangeRequestPatch: hReadChangeRequestPatch,
  readChangeRequestFile: hReadChangeRequestFile,
  liveSummaries: hLiveSummaries,
  readChangeRequestHead: hReadChangeRequestHead,
  resolveChangeRequestSource: hResolveChangeRequestSource,
  'mutation.resolveTarget': hMutationResolveTarget,
  'mutation.perform': hMutationPerform,
  'mutation.reconcile': hMutationReconcile,
};

function formatError(err: unknown): { message: string; status?: number; code?: string } {
  if (err instanceof CallError) {
    const out: { message: string; status?: number; code?: string } = {
      message: err.message.slice(0, 2_000),
      code: err.code,
    };
    if (typeof err.status === 'number' && err.status >= 400 && err.status <= 599) {
      out.status = err.status;
    }
    return out;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { message: `Internal error: ${msg}`.slice(0, 2_000), code: 'INTERNAL_ERROR', status: 500 };
}

async function dispatch(body: string): Promise<{ status: number; payload: unknown }> {
  const req = readSourceControlProviderRequest(body);
  if (!req) {
    return { status: 400, payload: { error: { message: 'Invalid source-control wire v1 request.' } } };
  }
  try {
    const data = await handlers[req.method](req);
    return { status: 200, payload: { ok: true, data } };
  } catch (err) {
    return { status: 200, payload: { ok: false, error: formatError(err) } };
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export type StartedService = {
  server: http.Server;
  port: number;
  dataDir: string | null;
  close(): Promise<void>;
};

export async function startService(opts: { env?: Record<string, string | undefined> } = {}): Promise<StartedService> {
  const env = opts.env ?? process.env;
  const token = String(env.OPENCHAMBER_SERVICE_TOKEN ?? '');
  const port = Number(env.OPENCHAMBER_SERVICE_PORT ?? 0);
  if (!token) {
    throw new Error('OPENCHAMBER_SERVICE_TOKEN is required');
  }

  const dataDir = String(env.OPENCHAMBER_SERVICE_DATA_DIR ?? '') || null;
  forge = env.OPENCHAMBER_HOST_CALLBACK_URL ? createSourceControlForge({ env }) : null;
  store = new ContextPathStore(dataDir);
  await store.load();

  const expectedAuth = Buffer.from(`Bearer ${token}`, 'utf8');
  const server = http.createServer(async (req, res) => {
    const actualAuth = Buffer.from(req.headers.authorization ?? '', 'utf8');
    if (actualAuth.length !== expectedAuth.length || !timingSafeEqual(actualAuth, expectedAuth)) {
      sendJson(res, 401, { error: { message: 'Unauthorized' } });
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && path === SOURCE_CONTROL_PROVIDER_PATH) {
        const body = await readBody(req, 8_000_000);
        const out = await dispatch(body);
        sendJson(res, out.status, out.payload);
        return;
      }
      sendJson(res, 404, { error: { message: 'Not found' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, msg === 'payload_too_large' ? 413 : 500, { error: { message: msg } });
    }
  });
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  return {
    server,
    port: boundPort,
    dataDir,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  if (!process.env.OPENCHAMBER_SERVICE_PORT || !process.env.OPENCHAMBER_SERVICE_TOKEN) {
    console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
    process.exit(1);
  }
  startService().catch((err) => {
    console.error('openchamber-bitbucket-dc failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
