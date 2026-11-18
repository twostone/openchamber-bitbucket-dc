import type { SourceControlForge } from '@openchamber/sdk';

export type Identity = {
  provider: string;
  instance: string;
};

export type CallCtx = {
  origin: string;
  originUrl: URL;
  handle: string;
  forge: SourceControlForge;
  ctx: string;
  provider: string;
  identity: Identity;
  user: { id: number | string; login: string } | null;
};

export type RepoIdent = {
  dtoOwner: string;
  repo: string;
  apiKey: string;
  dtoId?: string;
  remoteName?: string;
};

export type DtoProject = Identity & {
  id: string;
  owner: string;
  name: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
  defaultBranch?: string;
  remoteName?: string | null;
};

export type DtoUser = Identity & {
  id: string;
  username: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
};

export class CallError extends Error {
  constructor(
    override readonly message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function iso(tsMs?: number | null): string | undefined {
  if (typeof tsMs !== 'number' || !Number.isFinite(tsMs)) return undefined;
  return new Date(tsMs).toISOString();
}
