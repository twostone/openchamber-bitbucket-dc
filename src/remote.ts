import { execFile } from 'node:child_process';
import { CallError, type RepoIdent } from './types.js';

export type ParsedRemote = {
  hostname: string;
  port: number;
  /** Owner string matching OpenChamber's splitProjectPath on the remote URL. */
  dtoOwner: string;
  /** Bitbucket Data Center project key (`PROJ`, `acme`, `~alice`). */
  projectKey: string;
  /** Repository slug without `.git`. */
  slug: string;
  /** Context path (`/stash` or `""`) when the remote URL is an HTTP(S) `/scm/` URL, else null. */
  ctxHint: string | null;
  raw: string;
};

export function readRemoteUrl(repoDir: string, remoteName: string): Promise<string> {
  if (!repoDir || !remoteName) {
    return Promise.reject(new CallError('Repository directory and remote name are required.', 'BAD_REQUEST', 400));
  }
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoDir, 'remote', 'get-url', '--', remoteName], { timeout: 5_000 }, (err, stdout) => {
      const url = (stdout || '').trim();
      if (err || !url) {
        reject(new CallError(`The remote "${remoteName}" could not be read.`, 'REMOTE_NOT_FOUND', 404));
        return;
      }
      resolve(url);
    });
  });
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const GIT_SUFFIX = /\.git$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9_~.-]+$/;

function validateSegs(segs: string[], raw: string): void {
  if (segs.length < 2 || segs.some((s) => !s || s === '.' || s === '..' || !SAFE_SEGMENT.test(s))) {
    throw new CallError(`Remote URL "${raw}" does not name a Bitbucket repository.`, 'INVALID_REMOTE', 400);
  }
}

function splitCleanPath(cleanPath: string, isWeb: boolean, raw: string): {
  dtoOwner: string;
  projectKey: string;
  slug: string;
  ctxHint: string | null;
} {
  const segs = cleanPath.split('/').filter(Boolean);
  validateSegs(segs, raw);
  const slash = cleanPath.lastIndexOf('/');
  const dtoOwner = cleanPath.slice(0, slash);
  const slug = segs[segs.length - 1];

  const scmIdx = segs.findIndex((s) => s.toLowerCase() === 'scm');
  if (scmIdx >= 0 && scmIdx + 2 === segs.length - 1) {
    const ctxHint = scmIdx > 0 ? `/${segs.slice(0, scmIdx).join('/')}` : '';
    return { dtoOwner, projectKey: segs[scmIdx + 1], slug, ctxHint };
  }
  if (segs.length === 2) {
    return { dtoOwner, projectKey: segs[0], slug, ctxHint: isWeb ? '' : null };
  }
  throw new CallError(`Remote URL "${raw}" is not a valid Bitbucket clone path.`, 'INVALID_REMOTE', 400);
}

export function parseRemote(url: string, originUrl?: URL): ParsedRemote {
  const trimmed = url.trim();
  if (trimmed.includes('://')) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new CallError(`Unsupported remote URL: ${trimmed}`, 'INVALID_REMOTE', 400);
    }
    const isWeb = u.protocol === 'https:' || u.protocol === 'http:';
    if (!isWeb && u.protocol !== 'ssh:') {
      throw new CallError(`Unsupported remote protocol: ${u.protocol}`, 'INVALID_REMOTE', 400);
    }
    if (originUrl) {
      const matches = isWeb
        ? u.host.toLowerCase() === originUrl.host.toLowerCase()
        : u.hostname.toLowerCase() === originUrl.hostname.toLowerCase();
      if (!matches) {
        throw new CallError(`Remote "${trimmed}" does not belong to ${originUrl.origin}.`, 'REMOTE_NOT_ON_INSTANCE', 404);
      }
    }
    const port = u.port
      ? Number.parseInt(u.port, 10)
      : u.protocol === 'ssh:'
        ? 22
        : u.protocol === 'https:'
          ? 443
          : 80;
    const cleanPath = dec(u.pathname).replace(/^\/+|\/+$/g, '').replace(GIT_SUFFIX, '');
    const parsed = splitCleanPath(cleanPath, isWeb, trimmed);
    return { hostname: u.hostname.toLowerCase(), port, ...parsed, raw: trimmed };
  }

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) {
    const host = scp[1].toLowerCase();
    if (originUrl && host !== originUrl.hostname.toLowerCase()) {
      throw new CallError(`Remote "${trimmed}" does not belong to ${originUrl.origin}.`, 'REMOTE_NOT_ON_INSTANCE', 404);
    }
    let cleanPath = dec(scp[2]).replace(/^\/+|\/+$/g, '').replace(GIT_SUFFIX, '');
    let port = 22;
    const portPrefix = /^(\d+)\/(.+)$/.exec(cleanPath);
    if (portPrefix) {
      port = Number.parseInt(portPrefix[1], 10);
      cleanPath = portPrefix[2];
    }
    const parsed = splitCleanPath(cleanPath, false, trimmed);
    return { hostname: host, port, ...parsed, raw: trimmed };
  }

  throw new CallError(`Unsupported remote URL: ${trimmed}`, 'INVALID_REMOTE', 400);
}

/**
 * Extract the Bitbucket REST `projectKey` from an OpenChamber `owner` string
 * (handles `PROJ`, `acme`, `~alice`, and HTTP clone prefixes like `stash/scm/acme`).
 */
export function apiProjectKeyOfOwner(owner: string): string {
  const trimmed = (owner ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const segs = trimmed.split('/').filter(Boolean);
  const scmIdx = segs.findIndex((s) => s.toLowerCase() === 'scm');
  if (scmIdx >= 0 && segs[scmIdx + 1]) return segs[scmIdx + 1];
  return segs[segs.length - 1];
}

export function repoIdentFrom(
  selector: { id?: string; owner?: string; name?: string; repo?: string } | null | undefined,
  parsed: ParsedRemote,
  remoteName?: string,
): RepoIdent {
  const selName = selector?.name || selector?.repo;
  if (selector && typeof selector.owner === 'string' && selector.owner && typeof selName === 'string' && selName) {
    return {
      dtoOwner: selector.owner,
      repo: selName,
      apiKey: apiProjectKeyOfOwner(selector.owner),
      dtoId: selector.id ? String(selector.id) : undefined,
      remoteName,
    };
  }
  return {
    dtoOwner: parsed.dtoOwner,
    repo: parsed.slug,
    apiKey: parsed.projectKey,
    remoteName,
  };
}
