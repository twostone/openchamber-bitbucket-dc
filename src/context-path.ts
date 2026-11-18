import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SourceControlForge } from '@openchamber/sdk';

export class ContextPathStore {
  private mem = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string | null) {}

  async load(): Promise<void> {
    if (!this.dataDir) return;
    try {
      const raw = await fs.readFile(join(this.dataDir, 'instances.json'), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [origin, ctx] of Object.entries(parsed)) {
        if (typeof ctx === 'string') this.mem.set(origin, normalizeCtx(ctx));
      }
    } catch {
      // Missing or unreadable persistence falls back to the in-memory map.
    }
  }

  get(origin: string): string | undefined {
    return this.mem.get(origin);
  }

  set(origin: string, ctx: string): void {
    const normalized = normalizeCtx(ctx);
    if (this.mem.get(origin) === normalized) return;
    this.mem.set(origin, normalized);
    const dir = this.dataDir;
    if (!dir) return;
    const snapshot = Object.fromEntries(this.mem);
    this.writeChain = this.writeChain.then(async () => {
      const file = join(dir, 'instances.json');
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await fs.rename(tmp, file);
      } catch {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
    });
  }
}

export function normalizeCtx(ctx: string): string {
  const trimmed = (ctx || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export type DetectionBasis =
  | 'cache'
  | 'application-properties'
  | 'application-properties-auth-required'
  | 'status'
  | 'meta'
  | 'none';

export type Detection = {
  ctx: string;
  basis: DetectionBasis;
  props?: Record<string, unknown>;
};

type ProbeHit =
  | { ok: true; basis: Exclude<DetectionBasis, 'cache' | 'none'>; props?: Record<string, unknown> }
  | { ok: false };

async function probeCandidate(
  forge: SourceControlForge,
  handle: string,
  ctx: string,
): Promise<ProbeHit> {
  const propsRes = await forgeGet(forge, handle, `${ctx}/rest/api/latest/application-properties`, { accept: 'application/json' });
  if (propsRes) {
    if (propsRes.status === 200) {
      const json = parseJsonObject(propsRes.body);
      if (json && (json.displayName != null || json.version != null || json.buildNumber != null)) {
        return { ok: true, basis: 'application-properties', props: json };
      }
    } else if (propsRes.status === 401) {
      const json = parseJsonObject(propsRes.body);
      if (json && Array.isArray(json.errors) && json.errors.length > 0) {
        return { ok: true, basis: 'application-properties-auth-required' };
      }
    }
  }
  const statusRes = await forgeGet(forge, handle, `${ctx}/status`, { accept: 'application/json' });
  if (statusRes && statusRes.status === 200) {
    const json = parseJsonObject(statusRes.body);
    if (json && typeof json.state === 'string') {
      return { ok: true, basis: 'status' };
    }
  }
  return { ok: false };
}

export async function detectContextPath(opts: {
  store: ContextPathStore;
  forge: SourceControlForge | null;
  handle: string;
  origin: string;
  hint?: string | null;
  forceProbe?: boolean;
}): Promise<Detection> {
  if (!opts.forceProbe) {
    const cached = opts.store.get(opts.origin);
    if (cached !== undefined) {
      return { ctx: cached, basis: 'cache' };
    }
  }

  if (!opts.forge) return { ctx: '', basis: 'none' };

  const candidates: string[] = [];
  const push = (c: string) => {
    const n = normalizeCtx(c);
    if (!candidates.includes(n)) candidates.push(n);
  };
  if (opts.hint !== undefined && opts.hint !== null) push(opts.hint);
  const cached = opts.store.get(opts.origin);
  if (cached !== undefined) push(cached);
  for (const c of ['', '/bitbucket', '/stash', '/git']) push(c);

  for (const ctx of candidates) {
    const hit = await probeCandidate(opts.forge, opts.handle, ctx);
    if (hit.ok) {
      opts.store.set(opts.origin, ctx);
      return { ctx, basis: hit.basis, props: hit.props };
    }
  }

  const metaCtx = await readMetaContextPath(opts.forge, opts.handle);
  if (metaCtx !== null && !candidates.includes(metaCtx)) {
    const hit = await probeCandidate(opts.forge, opts.handle, metaCtx);
    if (hit.ok) {
      opts.store.set(opts.origin, metaCtx);
      return { ctx: metaCtx, basis: 'meta', props: hit.props };
    }
  }

  return { ctx: '', basis: 'none' };
}

async function readMetaContextPath(forge: SourceControlForge, handle: string): Promise<string | null> {
  const res = await forgeGet(forge, handle, '/', { accept: 'text/html' });
  if (!res || res.status !== 200) return null;
  for (const tag of res.body.match(/<meta[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name === 'ajs-context-path' && typeof content === 'string') {
      return normalizeCtx(content);
    }
  }
  return null;
}

async function forgeGet(
  forge: SourceControlForge,
  handle: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string } | null> {
  try {
    const res = await forge.request(handle, { method: 'GET', path, headers });
    return { status: res.status, body: res.body };
  } catch {
    return null;
  }
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
