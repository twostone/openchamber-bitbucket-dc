# openchamber-bitbucket-dc

Bitbucket Data Center (formerly Atlassian Stash) Git host extension for [OpenChamber](https://github.com/openchamber/openchamber) (`>= 2.7.1`).

Adds **Bitbucket Data Center** (`ext-bitbucket-dc`) alongside GitHub, GitLab, Gitea, Forgejo, and Gerrit in **Settings → Integrations**, bringing pull requests, branch status badges, diffs, reviews, comments, merge checks, and CI build statuses into OpenChamber.

## Features

- **Pull requests (`#123`)** — list, filter (`open` / `closed` / `merged` / `all`, text query, authored, review-requested), inspect, create (empty reviewers by default), edit title/description, convert between draft and ready, decline, reopen, and merge (`merge`, `squash`, `rebase` mapped to the repository's enabled Bitbucket strategies).
- **Safe Bitbucket DC updates** — every `PUT /pull-requests/{id}` preserves optimistic-concurrency `version`, `toRef`, `draft`, and existing `reviewers` so metadata edits never wipe reviewers.
- **Diffs & side-by-side file view** — streams unified diffs (`pull-requests/{id}.diff`), resolves true common ancestors via `/commits/{sha}/merge-base?otherCommitId=...`, and reads base/head file revisions including cross-repository forks (`repo.origin`).
- **Threaded comments & reviews** — renders nested comment replies and resolved thread state from `/activities` (`COMMENTED` + `REVIEW_COMMENTED`), supports comment create/edit/delete with optimistic locking, and submits verdicts (`APPROVED` / `NEEDS_WORK`) via `/participants/{userSlug}`.
- **Submit requirements & PR stacks** — surfaces Bitbucket merge vetoes and unresolved PR task counts directly next to the Merge button, and detects stacked branch-on-branch pull request chains.
- **CI build status** — reads fast commit build counters (`/rest/build-status/latest/commits/stats/{sha}`) for badges/summaries and individual build runs (`/rest/build-status/latest/commits/{sha}`) in PR details.
- **Automatic context-path discovery** — works with root instances (`https://bitbucket.example.com`) as well as subpath deployments (`/bitbucket`, `/stash`, `/git`, or custom `<meta name="ajs-context-path">` paths).
- **Zero token exposure to UI** — HTTP access tokens stay inside OpenChamber's encrypted credential store and are injected by OpenChamber's loopback outbound proxy.

## Installation

### From Git URL (recommended)

1. Open **Settings → Extensions** in OpenChamber.
2. Paste `https://github.com/twostone/openchamber-bitbucket-dc.git` into **Folder, ZIP, or URL** and click **Add**.
3. Review the requested permissions (**Acts as the Git host Bitbucket Data Center**, **Run a local service** with `git`) and choose **Allow and enable**.

### From Release ZIP

Download `openchamber-bitbucket-dc.zip` from [GitHub Releases](https://github.com/twostone/openchamber-bitbucket-dc/releases) and drop it onto **Settings → Extensions**.

## Connecting an Account

1. In Bitbucket Data Center, create a personal **HTTP access token** under **Profile → Manage account → HTTP access tokens** (`/plugins/servlet/access-tokens/manage`) with **`PROJECT_READ`** (Project read) and **`REPO_WRITE`** (Repository write) permissions.
2. Open **Settings → Integrations → Bitbucket Data Center** in OpenChamber.
3. Enter **only the server origin** (for example `https://git.example.com` — **without** a trailing `/stash` or `/bitbucket` path; OpenChamber requires origin URLs and this extension detects the context path automatically) and paste your token.

### Note on Custom SSH Ports (`:7999` / `:4444`)

Bitbucket Data Center commonly serves SSH Git traffic on a dedicated port such as `ssh://git@git.example.com:7999/proj/repo.git`. Because OpenChamber's Extension SDK v1 does not expose a separate `sshUrl` field on extension host cards:

- Open **Settings → Git Identities**, create or edit your SSH identity, link it to your connected **Bitbucket Data Center** account, and select that identity on the repository once. Once bound, branch badges, PR boards, reviews, and merges work over custom SSH ports.
- Alternatively, configure `Port 7999` for the host in `~/.ssh/config` and use SCP-style remotes (`git@git.example.com:proj/repo.git`).

## Development

Requires **Node.js 22+** and **npm**.

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # bundles src/main.ts -> service/main.js
npm test            # contract suite against Bitbucket DC 10.5 fake + SDK Zod schemas
npm run pack        # builds openchamber-bitbucket-dc.zip
```

## License

[MIT](LICENSE)
