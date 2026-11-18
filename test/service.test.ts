import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceControlProviderSchemasV1 as S, parseManifestJson } from '@openchamber/sdk/schemas';
import {
  startFakeBitbucket,
  startOutboundProxy,
  mkUser,
  mkRepoRef,
  type FakeBB,
  type OutboundProxy,
  type PR,
  type RepoRec,
  type UserRec,
} from './fake-bitbucket.ts';
// @ts-expect-error -- bundled ESM entry built without .d.ts
import { startService } from '../service/main.js';

const SVC_TOK = 'svc-secret';
const H_ANON = 'anon-probe';
const H_READ = 'alice-read';
const H_WRITE = 'alice-write';
const H_BOB_WRITE = 'bob-write';
const H_BAD = 'bad-token-handle';

type Env = { ok: boolean; data?: any; error?: { message: string; status?: number; code?: string } };

const MASTER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FB = 'cccccccccccccccccccccccccccccccccccccccc';
const BASE = 'dddddddddddddddddddddddddddddddddddddddd';

let fake!: FakeBB;
let proxy!: OutboundProxy;
let svcPort!: number;
let svcOrigin!: string;
let svcClose!: () => Promise<void>;
let dirSsh!: string;
let dirHttps!: string;
let dirFork!: string;
let dirPersonal!: string;
let alice!: UserRec;
let bob!: UserRec;
let carol!: UserRec;
let seq = 0;

const DIFF = [
  'diff --git a/src/util.ts b/src/util.ts',
  'index 1111111..2222222 100644',
  '--- a/src/util.ts',
  '+++ b/src/util.ts',
  '@@ -1,4 +1,5 @@',
  ' line one',
  '-old line',
  '+new line',
  '+extra line',
  ' line four',
  'diff --git a/notes.md b/notes.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.md',
  '@@ -0,0 +1,2 @@',
  '+# Notes',
  '+hello world',
].join('\n');

function gitRemote(dir: string, url: string): void {
  execSync(`git init -q "${dir}"`);
  execSync(`git -C "${dir}" remote add origin "${url}"`);
}

async function setUp(): Promise<void> {
  // Email-style login (`name`) vs underscore `slug`, matching enterprise Bitbucket DC setups
  alice = mkUser({ id: 1, name: 'alice@example.test', slug: 'alice_example.test', displayName: 'Alice Doe' });
  bob = mkUser({ id: 2, name: 'bob@example.test', slug: 'bob_example.test', displayName: 'Bob Roe' });
  carol = mkUser({ id: 3, name: 'carol@example.test', slug: 'carol_example.test', displayName: 'Carol Poe' });
  const dave = mkUser({ id: 4, name: 'dave', active: false });
  const bot = mkUser({ id: 5, name: 'ci-bot', type: 'SERVICE' });

  fake = await startFakeBitbucket({ ctx: '/stash' });
  const st = fake.state;
  for (const u of [alice, bob, carol, dave, bot]) st.users.set(u.name, u);
  st.tokens.set('tok-alice', alice.name);
  st.tokens.set('tok-bob', bob.name);
  st.projects.set(2, { key: 'PROJ', name: 'Project' });
  st.projects.set(3, { key: 'FORK', name: 'Fork Project' });

  const addRepo = (r: RepoRec) => {
    st.repos.set(`${r.projectKey}/${r.slug}`, r);
    st.repoById.set(r.id, r);
    return r;
  };

  const app = addRepo({
    id: 10,
    slug: 'app',
    name: 'Application',
    projectKey: 'PROJ',
    projectId: 2,
    projectName: 'Project',
    defaultBranch: 'master',
  });
  const forkApp = addRepo({
    id: 20,
    slug: 'fork-app',
    name: 'Fork App',
    projectKey: 'FORK',
    projectId: 3,
    projectName: 'Fork Project',
    defaultBranch: 'master',
    originRepoId: 10,
  });
  addRepo({
    id: 30,
    slug: 'notes',
    name: 'Notes',
    projectKey: '~alice_example.test',
    projectId: 9,
    projectName: 'Alice Personal',
    defaultBranch: 'main',
  });

  const addPr = (over: Partial<PR> & { id: number }): PR => {
    const now = Date.now();
    const pr: PR = {
      version: 1,
      title: `PR ${over.id}`,
      description: 'Initial PR body',
      state: 'OPEN',
      open: true,
      draft: false,
      createdDate: now,
      updatedDate: now + over.id,
      fromRef: mkRepoRef('x', FA, app, fake.origin, '/stash'),
      toRef: mkRepoRef('master', MASTER, app, fake.origin, '/stash'),
      author: alice,
      participants: [],
      reviewers: [],
      mergeOutcome: 'CLEAN',
      ...over,
    } as PR;
    st.prs.set(pr.id, pr);
    return pr;
  };

  addPr({
    id: 101,
    title: 'Feature A',
    fromRef: mkRepoRef('feature/a', FA, app, fake.origin, '/stash'),
    version: 3,
    reviewers: [
      {
        user: bob,
        role: 'REVIEWER',
        approved: true,
        status: 'APPROVED',
        lastReviewedCommit: '9999999999999999999999999999999999999999', // stale commit: still authoritative APPROVED
      },
    ],
  });
  addPr({
    id: 102,
    title: 'Feature B stacked on A',
    fromRef: mkRepoRef('feature/b', FB, app, fake.origin, '/stash'),
    toRef: mkRepoRef('feature/a', FA, app, fake.origin, '/stash'),
    version: 1,
  });
  addPr({
    id: 103,
    title: 'Feature 3 with veto and task',
    fromRef: mkRepoRef('feat-3', '3333333333333333333333333333333333333333', app, fake.origin, '/stash'),
    version: 2,
    reviewers: [{ user: carol, role: 'REVIEWER', approved: false, status: 'UNAPPROVED' }],
    openTaskCount: 2,
    vetoes: [{ summaryMessage: 'Not all required builds have passed', detailedMessage: '1 build is still running' }],
  });
  for (let i = 4; i <= 7; i++) {
    addPr({
      id: 100 + i,
      title: `Padding ${i}`,
      fromRef: mkRepoRef(`feat-${i}`, `${String(i).repeat(40)}`, app, fake.origin, '/stash'),
    });
  }
  addPr({
    id: 200,
    title: 'Merged PR',
    state: 'MERGED',
    open: false,
    fromRef: mkRepoRef('old-branch', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', app, fake.origin, '/stash'),
    closedDate: Date.now(),
  });
  addPr({
    id: 110,
    title: 'Contributor PR from fork',
    fromRef: mkRepoRef('contrib-branch', 'deadbeef0000000000000000000000000000cafe', forkApp, fake.origin, '/stash'),
    author: bob,
  });

  st.diffs.set(101, DIFF);
  st.changes.set(101, [
    { path: { toString: 'src/util.ts' }, type: 'MODIFY', nodeType: 'FILE' },
    { path: { toString: 'notes.md' }, type: 'ADD', nodeType: 'FILE' },
    { path: { toString: 'src' }, type: 'MODIFY', nodeType: 'DIRECTORY' },
  ]);
  st.commitLists.set(101, [
    {
      id: '2222222222222222222222222222222222222222',
      displayId: '22222222222',
      authorTimestamp: Date.now(),
      message: 'feat: second commit\n\ndetailed body',
      author: { name: alice.name, displayName: alice.displayName },
    },
    {
      id: '1111111111111111111111111111111111111111',
      displayId: '11111111111',
      authorTimestamp: Date.now() - 5_000,
      message: 'feat: first commit',
      author: { name: alice.name, displayName: alice.displayName },
    },
  ]);
  // Real Bitbucket DC returns newest activities first AND emits a standalone COMMENTED
  // activity for replies in addition to nesting the reply inside the root comment!
  st.activities.set(101, [
    {
      id: 903,
      action: 'COMMENTED',
      createdDate: Date.now() - 1_000,
      user: bob,
      comment: {
        id: 502,
        version: 0,
        text: 'Reply from Bob',
        createdDate: Date.now() - 1_000,
        author: bob,
      },
    },
    {
      id: 901,
      action: 'COMMENTED',
      createdDate: Date.now() - 2_000,
      user: alice,
      comment: {
        id: 501,
        version: 0,
        text: 'Root discussion note',
        createdDate: Date.now() - 2_000,
        author: alice,
        threadResolved: false,
        severity: 'BLOCKER',
        state: 'OPEN',
        comments: [
          {
            id: 502,
            version: 0,
            text: 'Reply from Bob',
            createdDate: Date.now() - 1_000,
            author: bob,
          },
        ],
      },
    },
    {
      id: 902,
      action: 'REVIEW_COMMENTED',
      createdDate: Date.now(),
      user: bob,
      commentAnchor: { path: 'src/util.ts', line: 3 },
      comment: {
        id: 503,
        version: 0,
        text: 'Inline review note',
        createdDate: Date.now(),
        author: bob,
      },
    },
  ]);

  st.buildStats.set(FA, { successful: 2, inProgress: 0, failed: 0, cancelled: 0, unknown: 0 });
  st.buildRuns.set(FA, [
    {
      key: 'jenkins-ci',
      name: 'Jenkins PR Build #42',
      url: 'https://ci.example.test/job/42',
      description: 'All tests passed',
      state: 'SUCCESSFUL',
      createdDate: Date.now() - 10_000,
      updatedDate: Date.now(),
    },
  ]);
  st.mergeBases.set(`10:${FA}:${MASTER}`, BASE);
  st.files.set(`10:${BASE}:src/util.ts`, 'line one\nold line\nline four\n');
  st.files.set(`10:${FA}:src/util.ts`, 'line one\nnew line\nextra line\nline four\n');
  st.files.set(`10:${FA}:notes.md`, '# Notes\nhello world\n');

  const base = mkdtempSync(join(tmpdir(), 'oc-bbdc-test-'));
  dirSsh = join(base, 'git-ssh');
  dirHttps = join(base, 'git-https');
  dirFork = join(base, 'git-fork');
  dirPersonal = join(base, 'git-personal');
  // Lowercase project key in SSH & HTTP clone URLs, just like real Bitbucket DC!
  gitRemote(dirSsh, 'ssh://git@127.0.0.1:4444/proj/app.git');
  gitRemote(dirHttps, `${fake.origin}/stash/scm/proj/app.git`);
  gitRemote(dirFork, 'ssh://git@127.0.0.1:4444/fork/fork-app.git');
  gitRemote(dirPersonal, 'ssh://git@127.0.0.1:4444/~alice_example.test/notes.git');

  proxy = await startOutboundProxy(
    fake,
    new Map([
      [H_ANON, { token: null, role: 'read' }],
      [H_READ, { token: 'tok-alice', role: 'read' }],
      [H_WRITE, { token: 'tok-alice', role: 'write' }],
      [H_BOB_WRITE, { token: 'tok-bob', role: 'write' }],
      [H_BAD, { token: 'tok-invalid', role: 'read' }],
    ]),
  );

  const svc = await startService({
    env: {
      OPENCHAMBER_SERVICE_TOKEN: SVC_TOK,
      OPENCHAMBER_SERVICE_PORT: '0',
      OPENCHAMBER_SERVICE_DATA_DIR: join(base, 'svc-data'),
      OPENCHAMBER_HOST_CALLBACK_URL: proxy.origin,
    },
  });
  svcPort = svc.port;
  svcOrigin = `http://127.0.0.1:${svc.port}`;
  svcClose = () => svc.close();
}

await setUp();

after(async () => {
  await svcClose();
  await proxy.close();
  await fake.close();
});

async function rpc(
  method: string,
  input: Record<string, unknown>,
  handle = H_READ,
  user: { id: number; login: string } | null = { id: alice.id, login: alice.name },
): Promise<Env> {
  const res = await fetch(`${svcOrigin}/source-control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SVC_TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      requestId: `req-${++seq}`,
      provider: 'ext-bitbucket-dc',
      method,
      input,
      session: { instance: fake.origin, handle, user },
    }),
  });
  assert.equal(res.status, 200, `Expected HTTP 200 envelope for ${method}, got ${res.status}`);
  const raw = await res.json();
  const envCheck = S.envelope.safeParse(raw);
  assert.ok(envCheck.success, `Envelope schema failed for ${method}: ${JSON.stringify(envCheck.error?.issues)}`);
  return raw as Env;
}

function okData(env: Env, method: keyof typeof S.data): any {
  assert.equal(env.ok, true, `Expected ok:true for ${method}, got ${JSON.stringify(env.error)}`);
  const parsed = S.data[method].safeParse(env.data);
  assert.ok(parsed.success, `Schema validation failed for ${method}: ${JSON.stringify(parsed.error?.issues)}`);
  return env.data;
}

const SSH_BINDING_CTX = {
  directory: '',
  repositoryId: 'repo-ssh-app',
  bindingRevision: 2,
  primaryRemote: 'origin',
};

const readInput = (dir: string, extra: Record<string, unknown> = {}) => ({
  directory: dir,
  remote: 'origin',
  context: { ...SSH_BINDING_CTX, directory: dir },
  ...extra,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('health requires bearer token; malformed wire body returns 400', async () => {
  assert.equal((await fetch(`${svcOrigin}/health`)).status, 401);
  assert.equal((await fetch(`${svcOrigin}/health`, { headers: { authorization: `Bearer ${SVC_TOK}` } })).status, 200);
  assert.equal((await fetch(`${svcOrigin}/unknown`, { headers: { authorization: `Bearer ${SVC_TOK}` } })).status, 404);

  const bad = await fetch(`${svcOrigin}/source-control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SVC_TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 999 }),
  });
  assert.equal(bad.status, 400);
});

test('auth.probe discovers /stash context path and Bitbucket DC 10.5 version without token', async () => {
  const d = okData(await rpc('auth.probe', {}, H_ANON, null), 'auth.probe');
  assert.equal(d.supported, true);
  assert.equal(d.version, '10.5.0');
});

test('auth.verify resolves email user.name via whoami + /users?filter, falls back to dashboard, and relays genuine 401', async () => {
  const d = okData(await rpc('auth.verify', {}, H_READ, null), 'auth.verify');
  assert.equal(d.user.id, 1);
  assert.equal(d.user.login, 'alice@example.test');
  assert.equal(d.user.name, 'Alice Doe');

  // Fallback when /plugins/servlet/applinks/whoami is blocked on a hardened proxy
  fake.state.whoamiEnabled = false;
  try {
    const fallback = okData(await rpc('auth.verify', {}, H_READ, null), 'auth.verify');
    assert.equal(fallback.user.login, 'alice@example.test');
  } finally {
    fake.state.whoamiEnabled = true;
  }

  const bad = await rpc('auth.verify', {}, H_BAD, null);
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.status, 401);
});

test('changeRequestStatus preserves lowercase SSH dtoOwner, aggregates mergeability, CI, and 2-layer stack', async () => {
  const d = okData(await rpc('changeRequestStatus', readInput(dirSsh, { branch: 'feature/b' })), 'changeRequestStatus');
  assert.equal(d.identity.provider, 'ext-bitbucket-dc');
  assert.equal(d.project.owner, 'proj'); // Preserves remote case for OpenChamber target checks
  assert.equal(d.changeRequest.number, 102);
  assert.equal(d.canMerge, true);
  assert.equal(d.defaultBranch, 'master');
  // Stack walked down from feature/b (102) -> feature/a (101) -> master!
  assert.equal(d.stack.base, 'master');
  assert.deepEqual(
    d.stack.layers.map((l: any) => l.number),
    [101, 102],
  );
});

test('HTTPS /stash/scm/proj/app.git remote preserves stash/scm/proj dtoOwner while resolving Bitbucket PROJ/app', async () => {
  const d = okData(
    await rpc('changeRequestStatus', readInput(dirHttps, { branch: 'feature/a' })),
    'changeRequestStatus',
  );
  assert.equal(d.project.owner, 'stash/scm/proj');
  assert.equal(d.changeRequest.number, 101);
  assert.equal(d.ci.summary.state, 'success');
});

test('listChangeRequests walks pages strictly via nextPageStart and supports state & people filters', async () => {
  const p1 = okData(await rpc('listChangeRequests', readInput(dirSsh, { state: 'open', page: 1 })), 'listChangeRequests');
  assert.equal(p1.page, 1);
  assert.equal(p1.items.length, 3);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.items[0].provider, 'ext-bitbucket-dc');
  assert.ok(Array.isArray(p1.items[0].labels));

  const p2 = okData(await rpc('listChangeRequests', readInput(dirSsh, { state: 'open', page: 2 })), 'listChangeRequests');
  assert.equal(p2.page, 2);
  assert.notDeepEqual(
    p1.items.map((x: any) => x.number),
    p2.items.map((x: any) => x.number),
  );

  const merged = okData(
    await rpc('listChangeRequests', readInput(dirSsh, { state: 'merged', page: 1 })),
    'listChangeRequests',
  );
  assert.deepEqual(
    merged.items.map((x: any) => x.number),
    [200],
  );

  const requested = okData(
    await rpc('listChangeRequests', readInput(dirSsh, { state: 'open', people: 'reviewRequested', page: 1 }), H_READ, {
      id: carol.id,
      login: carol.name,
    }),
    'listChangeRequests',
  );
  assert.deepEqual(
    requested.items.map((x: any) => x.number),
    [103],
  );
});

test('changeRequestContext returns exact OpenChamber ChangeRequestContext DTO with threads, diffs, verdicts, CI & submitRequirements', async () => {
  const d = okData(
    await rpc(
      'changeRequestContext',
      readInput(dirSsh, { number: 101, includeDiff: true, includeCIDetails: true, includeTimeline: true }),
    ),
    'changeRequestContext',
  );
  assert.equal(d.identity.provider, 'ext-bitbucket-dc');
  assert.equal(d.changeRequest.number, 101);
  assert.equal(d.changeRequest.body, 'Initial PR body');
  assert.equal(d.changeRequest.author.username, 'alice@example.test');

  // Files & diff chunks (directory entry ignored)
  assert.equal(d.files.length, 2);
  const utilFile = d.files.find((f: any) => f.path === 'src/util.ts');
  assert.equal(utilFile.status, 'modified');
  assert.equal(utilFile.additions, 2);
  assert.equal(utilFile.deletions, 1);
  assert.ok(utilFile.patch.startsWith('diff --git a/src/util.ts b/src/util.ts'));

  // Threaded comments: body untouched (no prefix!), root cannot be deleted because it has a reply
  assert.equal(d.issueComments.length, 2);
  assert.equal(d.issueComments[0].body, 'Root discussion note');
  assert.equal(d.issueComments[0].thread.first, true);
  assert.equal(d.issueComments[0].canUpdate, true);
  assert.equal(d.issueComments[0].canDelete, false);
  assert.equal(d.issueComments[1].thread.first, false);

  // REVIEW_COMMENTED anchored comment lands in reviewComments
  assert.equal(d.reviewComments.length, 1);
  assert.equal(d.reviewComments[0].path, 'src/util.ts');
  assert.equal(d.reviewComments[0].line, 3);

  // Stale lastReviewedCommit still preserves Bitbucket's authoritative APPROVED verdict
  assert.equal(d.verdicts.length, 1);
  assert.equal(d.verdicts[0].state, 'approved');
  assert.equal(d.verdicts[0].author.username, 'bob@example.test');

  // Timeline commits oldest-first with OpenChamber { sha, headline, authorName, committedAt, url }
  assert.equal(d.commits.length, 2);
  assert.equal(d.commits[0].headline, 'feat: first commit');
  assert.equal(d.commits[1].headline, 'feat: second commit');

  // CI run details
  assert.equal(d.ci.summary.state, 'success');
  assert.equal(d.ci.runs[0].status, 'completed');
  assert.equal(d.ci.runs[0].conclusion, 'success');

  // PR 103 submitRequirements: veto + open tasks
  const d103 = okData(
    await rpc('changeRequestContext', readInput(dirSsh, { number: 103, includeDiff: false, includeCIDetails: false, includeTimeline: false })),
    'changeRequestContext',
  );
  assert.equal(d103.submitRequirements.length, 2);
  assert.match(d103.submitRequirements[0].name, /builds/i);
  assert.equal(d103.submitRequirements[1].name, 'Open tasks (2)');
});

test('readChangeRequestPatch and readChangeRequestFile use /merge-base?otherCommitId= and empty strings for added files', async () => {
  const patchRes = okData(await rpc('readChangeRequestPatch', readInput(dirSsh, { number: 101 })), 'readChangeRequestPatch');
  assert.ok(patchRes.patch.includes('diff --git a/src/util.ts'));
  assert.deepEqual(patchRes.meta, { owner: 'proj', repo: 'app', number: 101 });

  const modFile = okData(
    await rpc('readChangeRequestFile', readInput(dirSsh, { number: 101, path: 'src/util.ts', status: 'M' })),
    'readChangeRequestFile',
  );
  // Must come from BASE (merge-base), NOT MASTER!
  assert.equal(modFile.original, 'line one\nold line\nline four\n');
  assert.equal(modFile.modified, 'line one\nnew line\nextra line\nline four\n');

  const addedFile = okData(
    await rpc('readChangeRequestFile', readInput(dirSsh, { number: 101, path: 'notes.md', status: 'A' })),
    'readChangeRequestFile',
  );
  assert.equal(addedFile.original, '');
  assert.equal(addedFile.modified, '# Notes\nhello world\n');
});

test('projectBranches, projectUpstream (repo.origin), and listReviewerCandidates return exact OpenChamber DTOs', async () => {
  const branches = okData(
    await rpc('projectBranches', readInput(dirSsh, { project: { owner: 'proj', name: 'app' } })),
    'projectBranches',
  );
  assert.ok(Array.isArray(branches));
  assert.ok(branches.includes('master'));
  assert.ok(branches.includes('feature/a'));

  const upstream = okData(await rpc('projectUpstream', readInput(dirFork)), 'projectUpstream');
  assert.equal(upstream.isFork, true);
  assert.equal(upstream.upstream.owner, 'PROJ');
  assert.equal(upstream.upstream.name, 'app');

  const candidates = okData(await rpc('listReviewerCandidates', readInput(dirSsh)), 'listReviewerCandidates');
  assert.ok(Array.isArray(candidates));
  const logins = candidates.map((c: any) => c.login);
  assert.ok(logins.includes('alice@example.test'));
  assert.ok(!logins.includes('dave'));
  assert.ok(!logins.includes('ci-bot'));
});

test('liveSummaries omits 404 PRs (per SDK contract) and surfaces open checks', async () => {
  const d = okData(
    await rpc('liveSummaries', {
      refs: [
        { owner: 'proj', repo: 'app', number: 101 },
        { owner: 'proj', repo: 'app', number: 9999 },
      ],
      issueRefs: [],
    }),
    'liveSummaries',
  );
  assert.equal(d.summaries.length, 1);
  assert.equal(d.summaries[0].number, 101);
  assert.equal(d.summaries[0].checks.state, 'success');
});

test('resolveChangeRequestSource satisfies OpenChamber requireEndpoint check for /stash/scm/ URLs and stale SHA check', async () => {
  const head = okData(await rpc('readChangeRequestHead', readInput(dirSsh, { number: 110 })), 'readChangeRequestHead');
  assert.equal(head.headBranch, 'contrib-branch');

  const src = okData(
    await rpc(
      'resolveChangeRequestSource',
      readInput(dirSsh, {
        project: { id: '10', owner: 'proj', name: 'app' },
        number: 110,
        expectedHeadSha: head.headSha,
      }),
    ),
    'resolveChangeRequestSource',
  );
  assert.equal(src.classification, 'contributor-fork');
  const epUrl = new URL(src.endpoint);
  assert.equal(epUrl.username, '', 'endpoint must strip Bitbucket userinfo credentials');
  assert.equal(epUrl.password, '');
  // Exact check from OpenChamber's extension-provider.js `requireEndpoint`:
  assert.equal(
    epUrl.pathname.replace(/^\//, '').replace(/\.git$/, ''),
    `${src.sourceProject.owner}/${src.sourceProject.name}`,
  );

  const stale = await rpc(
    'resolveChangeRequestSource',
    readInput(dirSsh, {
      project: { id: '10', owner: 'proj', name: 'app' },
      number: 110,
      expectedHeadSha: '0'.repeat(40),
    }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'SOURCE_CONTROL_CHANGE_REQUEST_STALE');
  assert.equal(stale.error?.status, 409);
});

test('personal repository (~alice_example.test) resolves over SSH and /users/{slug} selector', async () => {
  const d = okData(await rpc('listChangeRequests', readInput(dirPersonal, { state: 'all' })), 'listChangeRequests');
  assert.deepEqual(d.items, []);

  // Selector coming from pasted URL `/stash/users/alice_example.test/repos/notes/pull-requests/1` (no leading ~)
  const branches = okData(
    await rpc('projectBranches', readInput(dirPersonal, { project: { owner: 'alice_example.test', name: 'notes' } })),
    'projectBranches',
  );
  assert.deepEqual(branches, ['main']);
});

test('mutations: create (empty reviewers), update (preserves reviewers!), draft/ready, reviewers (names), review (slug), state & merge (method)', async () => {
  // 1. Create PR (head/base in context.target, body in input — matching standard-mutations.js!)
  const createCtx = {
    ...SSH_BINDING_CTX,
    directory: dirSsh,
    target: { project: { owner: 'proj', name: 'app' }, head: 'feature/new', base: 'master' },
  };
  const rtCreate = okData(
    await rpc('mutation.resolveTarget', {
      kind: 'change-request-create',
      context: createCtx,
      input: { title: 'New PR', body: 'Created from OpenChamber', draft: true },
    }),
    'mutation.resolveTarget',
  );
  assert.equal(rtCreate.target.project.id, '10');
  assert.equal(rtCreate.target.project.owner, 'proj');

  const perfCreate = okData(
    await rpc(
      'mutation.perform',
      {
        route: '/pr/create',
        kind: 'change-request-create',
        input: { title: 'New PR', body: 'Created from OpenChamber', draft: true },
        resolved: rtCreate,
      },
      H_WRITE,
    ),
    'mutation.perform',
  );
  const newNum = perfCreate.number;
  assert.equal(fake.state.prs.get(newNum)?.reviewers.length, 0);
  assert.equal(fake.state.prs.get(newNum)?.draft, true);

  const recCreate = okData(
    await rpc('mutation.reconcile', {
      route: '/pr/create',
      kind: 'change-request-create',
      input: { title: 'New PR', body: 'Created from OpenChamber', draft: true },
      resolved: rtCreate,
    }),
    'mutation.reconcile',
  );
  assert.equal(recCreate.state, 'succeeded');
  assert.equal(recCreate.result.number, newNum);

  // 2. Set reviewers via standard-mutations `{ names }`
  const itemCtx = (number: number, extraTarget: Record<string, unknown> = {}) => ({
    ...SSH_BINDING_CTX,
    directory: dirSsh,
    target: { project: { owner: 'proj', name: 'app' }, number, ...extraTarget },
  });
  const rtRev = okData(
    await rpc('mutation.resolveTarget', {
      kind: 'change-request-reviewers',
      context: itemCtx(newNum),
      input: { names: [bob.name, carol.name] },
    }),
    'mutation.resolveTarget',
  );
  okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/reviewers', kind: 'change-request-reviewers', input: { names: [bob.name, carol.name] }, resolved: rtRev },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(fake.state.prs.get(newNum)?.reviewers.length, 2);

  // 3. Update title & body — MUST NOT wipe the 2 reviewers even though fake Bitbucket wipes omitted reviewers!
  const rtUpd = okData(
    await rpc('mutation.resolveTarget', {
      kind: 'change-request-update',
      context: itemCtx(newNum),
      input: { title: 'Renamed PR', body: 'Updated description' },
    }),
    'mutation.resolveTarget',
  );
  okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/update', kind: 'change-request-update', input: { title: 'Renamed PR', body: 'Updated description' }, resolved: rtUpd },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(fake.state.prs.get(newNum)?.title, 'Renamed PR');
  assert.equal(fake.state.prs.get(newNum)?.description, 'Updated description');
  assert.equal(fake.state.prs.get(newNum)?.reviewers.length, 2);

  // 4. Mark ready for review
  const rtReady = okData(
    await rpc('mutation.resolveTarget', { kind: 'change-request-ready', context: itemCtx(newNum), input: {} }),
    'mutation.resolveTarget',
  );
  const perfReady = okData(
    await rpc('mutation.perform', { route: '/pr/ready', kind: 'change-request-ready', input: {}, resolved: rtReady }, H_WRITE),
    'mutation.perform',
  );
  assert.equal(perfReady.ready, true);
  assert.equal(fake.state.prs.get(newNum)?.draft, false);

  // 5. Submit review as Bob (resolves Bob's underscore slug `bob_example.test` on `/participants/{userSlug}`)
  const headSha = fake.state.prs.get(newNum)!.fromRef.latestCommit;
  const rtReview = okData(
    await rpc(
      'mutation.resolveTarget',
      {
        kind: 'change-request-review',
        context: itemCtx(newNum, { headSha }),
        input: { verdict: 'approve', body: 'LGTM!' },
      },
      H_READ,
      { id: bob.id, login: bob.name },
    ),
    'mutation.resolveTarget',
  );
  const perfReview = okData(
    await rpc(
      'mutation.perform',
      {
        route: '/pr/review',
        kind: 'change-request-review',
        input: { verdict: 'approve', body: 'LGTM!' },
        resolved: rtReview,
      },
      H_BOB_WRITE,
      { id: bob.id, login: bob.name },
    ),
    'mutation.perform',
  );
  assert.equal(perfReview.commented, true);
  assert.equal(fake.state.prs.get(newNum)?.participants[0]?.status, 'APPROVED');

  // 6. Decline & Reopen (`change-request-state`)
  const rtClose = okData(
    await rpc('mutation.resolveTarget', { kind: 'change-request-state', context: itemCtx(newNum), input: { state: 'closed' } }),
    'mutation.resolveTarget',
  );
  okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/state', kind: 'change-request-state', input: { state: 'closed' }, resolved: rtClose },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(fake.state.prs.get(newNum)?.state, 'DECLINED');

  const rtReopen = okData(
    await rpc('mutation.resolveTarget', { kind: 'change-request-state', context: itemCtx(newNum), input: { state: 'open' } }),
    'mutation.resolveTarget',
  );
  okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/state', kind: 'change-request-state', input: { state: 'open' }, resolved: rtReopen },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(fake.state.prs.get(newNum)?.state, 'OPEN');

  // 7. Merge using `method: 'squash'` (standard-mutations.js key!) — no autoMerge!
  const rtMerge = okData(
    await rpc('mutation.resolveTarget', { kind: 'change-request-merge', context: itemCtx(newNum), input: { method: 'squash' } }),
    'mutation.resolveTarget',
  );
  const perfMerge = okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/merge', kind: 'change-request-merge', input: { method: 'squash' }, resolved: rtMerge },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(perfMerge.merged, true);
  assert.equal(fake.state.lastMergeBody?.strategyId, 'squash');
  assert.equal(fake.state.lastMergeBody?.autoMerge, undefined);
});

test('comment lifecycle: add, update with version, delete, and read-only handle safety', async () => {
  const ctx101 = {
    ...SSH_BINDING_CTX,
    directory: dirSsh,
    target: { project: { owner: 'proj', name: 'app' }, number: 101 },
  };
  const rt = okData(
    await rpc('mutation.resolveTarget', { kind: 'change-request-comment', context: ctx101, input: { body: 'hello' } }),
    'mutation.resolveTarget',
  );
  okData(
    await rpc('mutation.perform', { route: '/pr/comment', kind: 'change-request-comment', input: { body: 'hello' }, resolved: rt }, H_WRITE),
    'mutation.perform',
  );
  const comments = [...fake.state.comments.get(101)!.values()];
  const cid = String(comments[comments.length - 1].id);

  okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/comment/update', kind: 'change-request-comment-update', input: { commentId: cid, body: 'updated' }, resolved: rt },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(fake.state.comments.get(101)!.get(Number(cid))!.text, 'updated');

  okData(
    await rpc(
      'mutation.perform',
      { route: '/pr/comment/delete', kind: 'change-request-comment-delete', input: { commentId: cid }, resolved: rt },
      H_WRITE,
    ),
    'mutation.perform',
  );
  assert.equal(fake.state.comments.get(101)!.has(Number(cid)), false);

  // Read-only handle refusal never claims HTTP 401
  const refused = await rpc(
    'mutation.perform',
    { route: '/pr/comment', kind: 'change-request-comment', input: { body: 'blocked' }, resolved: rt },
    H_READ,
  );
  assert.equal(refused.ok, false);
  assert.notEqual(refused.error?.status, 401);
});

test('package.json manifest and bundled service/main.js satisfy @openchamber/sdk guest checks', () => {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = parseManifestJson(raw);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.equal(parsed.manifest.contributes.panel.id, 'bitbucket-dc');
    assert.deepEqual(parsed.manifest.contributes.service?.provides, ['source-control']);
    assert.equal(parsed.manifest.contributes.sourceControl?.presentation.features.authorCanReview, false);
    assert.equal(parsed.manifest.contributes.sourceControl?.presentation.features.submitRequirements, true);
  }
  const bundle = readFileSync(new URL('../service/main.js', import.meta.url), 'utf8');
  assert.equal(/from\s+["']@openchamber\/sdk/.test(bundle), false, 'service/main.js must bundle @openchamber/sdk');
  assert.ok(bundle.includes('OPENCHAMBER_SERVICE_PORT'), 'service/main.js must read OPENCHAMBER_SERVICE_PORT');
});
