// src/main.ts
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = /* @__PURE__ */ new WeakMap();
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== void 0)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1e3));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;

// node_modules/@openchamber/sdk/dist/manifest.js
var GUEST_PROVIDER_LOGO_BYTES_MAX = 1024 * 1024;
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);

// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 6e4;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);

// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_SCHEDULE_IDLE_MS = 10 * 6e4;
var MENTIONS_IDLE_MS = 10 * 6e4;

// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 6e4;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);

// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 6e4;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_PATH = "/source-control";
var SOURCE_CONTROL_PROVIDER_WIRE_VERSION = 1;
var SOURCE_CONTROL_PROVIDER_METHODS = [
  "auth.verify",
  "auth.probe",
  "auth.status",
  "changeRequestStatus",
  "listChangeRequests",
  "changeRequestContext",
  "listIssues",
  "getIssue",
  "issueComments",
  "projectUpstream",
  "projectBranches",
  "listLabels",
  "listReviewerCandidates",
  "readChangeRequestPatch",
  "readChangeRequestFile",
  "liveSummaries",
  "readChangeRequestHead",
  "resolveChangeRequestSource",
  "mutation.resolveTarget",
  "mutation.perform",
  "mutation.reconcile"
];
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 6e4;
var OPENCHAMBER_HOST_CALLBACK_URL = "OPENCHAMBER_HOST_CALLBACK_URL";
var SOURCE_CONTROL_OUTBOUND_PATH = "/source-control/outbound";
var SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS = 2e4;
var isSourceControlProviderMethod = (value) => SOURCE_CONTROL_PROVIDER_METHODS.some((method) => method === value);
var readSessionUser = (user) => {
  if (user === null)
    return null;
  if (Object(user) !== user || user === void 0)
    return void 0;
  const { id, login } = user;
  const isPositiveSafeIntegerId = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  const isBoundedStringId = typeof id === "string" && id.length > 0 && id.length <= 256;
  const validId = isPositiveSafeIntegerId || isBoundedStringId;
  if (!validId || String(login) !== login || login.length === 0)
    return void 0;
  return { id, login };
};
var readSession = (session) => {
  if (session === null)
    return null;
  if (Object(session) !== session || session === void 0)
    return void 0;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0)
    return void 0;
  const user = readSessionUser(session.user);
  if (user === void 0)
    return void 0;
  return { instance, handle, user };
};
var readSourceControlProviderRequest = (body) => {
  let wire;
  try {
    const parsed = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null)
      return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, input } = wire;
  if (v !== SOURCE_CONTROL_PROVIDER_WIRE_VERSION)
    return null;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (String(provider) !== provider || provider.length === 0)
    return null;
  if (String(method) !== method || !isSourceControlProviderMethod(method))
    return null;
  if (Object(input) !== input || Array.isArray(input))
    return null;
  const session = readSession(wire.session);
  if (session === void 0)
    return null;
  return { v: SOURCE_CONTROL_PROVIDER_WIRE_VERSION, requestId, method, provider, session, input };
};
var SourceControlForgeError = class extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "SourceControlForgeError";
    this.code = code;
    this.status = status;
  }
};
var postOutbound = async (url, handle, request, timeoutMs, fail) => {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${handle}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      // A little past OpenChamber's own deadline, so its answer wins.
      signal: AbortSignal.timeout(timeoutMs + 5e3)
    });
  } catch (error) {
    throw fail(`OpenChamber did not answer: ${error instanceof Error ? error.message : String(error)}`, "HOST_UNAVAILABLE", 0);
  }
  let answer;
  try {
    answer = Object(await response.json());
  } catch {
    throw fail("OpenChamber answered with something other than JSON", "HOST_UNAVAILABLE", response.status);
  }
  if (!response.ok) {
    const message = answer.error?.message;
    const code = answer.error?.code;
    throw fail(String(message) === message && message.length > 0 ? message : `OpenChamber refused the request (${response.status})`, String(code) === code && code.length > 0 ? code : "OUTBOUND_REFUSED", response.status);
  }
  if (!Number.isSafeInteger(answer.status) || String(answer.body) !== answer.body) {
    throw fail("OpenChamber relayed a malformed answer", "HOST_UNAVAILABLE", response.status);
  }
  const headers = {};
  for (const [name, text] of Object.entries(Object(answer.headers ?? {}))) {
    if (String(text) === text)
      headers[name] = text;
  }
  return { status: Number(answer.status), headers, body: answer.body };
};
var createSourceControlForge = ({ env }) => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base)
    throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "source-control" can reach a forge.`);
  const url = `${base.replace(/\/+$/, "")}${SOURCE_CONTROL_OUTBOUND_PATH}`;
  return {
    request: (handle, request) => postOutbound(url, handle, request, SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS, (message, code, status) => new SourceControlForgeError(message, code, status))
  };
};
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 6e4;
var TRACKER_PROVIDER_IDLE_MS = 10 * 6e4;
var QUOTA_PROVIDER_IDLE_MS = 10 * 6e4;

// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);

// src/context-path.ts
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
var ContextPathStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  dataDir;
  mem = /* @__PURE__ */ new Map();
  writeChain = Promise.resolve();
  async load() {
    if (!this.dataDir) return;
    try {
      const raw = await fs.readFile(join(this.dataDir, "instances.json"), "utf8");
      const parsed = JSON.parse(raw);
      for (const [origin, ctx] of Object.entries(parsed)) {
        if (typeof ctx === "string") this.mem.set(origin, normalizeCtx(ctx));
      }
    } catch {
    }
  }
  get(origin) {
    return this.mem.get(origin);
  }
  set(origin, ctx) {
    const normalized = normalizeCtx(ctx);
    if (this.mem.get(origin) === normalized) return;
    this.mem.set(origin, normalized);
    const dir = this.dataDir;
    if (!dir) return;
    const snapshot = Object.fromEntries(this.mem);
    this.writeChain = this.writeChain.then(async () => {
      const file = join(dir, "instances.json");
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}
`, "utf8");
        await fs.rename(tmp, file);
      } catch {
        await fs.rm(tmp, { force: true }).catch(() => void 0);
      }
    });
  }
};
function normalizeCtx(ctx) {
  const trimmed = (ctx || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
async function probeCandidate(forge2, handle, ctx) {
  const propsRes = await forgeGet(forge2, handle, `${ctx}/rest/api/latest/application-properties`, { accept: "application/json" });
  if (propsRes) {
    if (propsRes.status === 200) {
      const json = parseJsonObject(propsRes.body);
      if (json && (json.displayName != null || json.version != null || json.buildNumber != null)) {
        return { ok: true, basis: "application-properties", props: json };
      }
    } else if (propsRes.status === 401) {
      const json = parseJsonObject(propsRes.body);
      if (json && Array.isArray(json.errors) && json.errors.length > 0) {
        return { ok: true, basis: "application-properties-auth-required" };
      }
    }
  }
  const statusRes = await forgeGet(forge2, handle, `${ctx}/status`, { accept: "application/json" });
  if (statusRes && statusRes.status === 200) {
    const json = parseJsonObject(statusRes.body);
    if (json && typeof json.state === "string") {
      return { ok: true, basis: "status" };
    }
  }
  return { ok: false };
}
async function detectContextPath(opts) {
  if (!opts.forceProbe) {
    const cached2 = opts.store.get(opts.origin);
    if (cached2 !== void 0) {
      return { ctx: cached2, basis: "cache" };
    }
  }
  if (!opts.forge) return { ctx: "", basis: "none" };
  const candidates = [];
  const push = (c) => {
    const n = normalizeCtx(c);
    if (!candidates.includes(n)) candidates.push(n);
  };
  if (opts.hint !== void 0 && opts.hint !== null) push(opts.hint);
  const cached = opts.store.get(opts.origin);
  if (cached !== void 0) push(cached);
  for (const c of ["", "/bitbucket", "/stash", "/git"]) push(c);
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
      return { ctx: metaCtx, basis: "meta", props: hit.props };
    }
  }
  return { ctx: "", basis: "none" };
}
async function readMetaContextPath(forge2, handle) {
  const res = await forgeGet(forge2, handle, "/", { accept: "text/html" });
  if (!res || res.status !== 200) return null;
  for (const tag of res.body.match(/<meta[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name === "ajs-context-path" && typeof content === "string") {
      return normalizeCtx(content);
    }
  }
  return null;
}
async function forgeGet(forge2, handle, path, headers) {
  try {
    const res = await forge2.request(handle, { method: "GET", path, headers });
    return { status: res.status, body: res.body };
  } catch {
    return null;
  }
}
function parseJsonObject(body) {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// src/remote.ts
import { execFile } from "node:child_process";

// src/types.ts
var CallError = class extends Error {
  constructor(message, code, status) {
    super(message);
    this.message = message;
    this.code = code;
    this.status = status;
  }
  message;
  code;
  status;
};
function iso(tsMs) {
  if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) return void 0;
  return new Date(tsMs).toISOString();
}

// src/remote.ts
function readRemoteUrl(repoDir, remoteName) {
  if (!repoDir || !remoteName) {
    return Promise.reject(new CallError("Repository directory and remote name are required.", "BAD_REQUEST", 400));
  }
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoDir, "remote", "get-url", "--", remoteName], { timeout: 5e3 }, (err, stdout) => {
      const url = (stdout || "").trim();
      if (err || !url) {
        reject(new CallError(`The remote "${remoteName}" could not be read.`, "REMOTE_NOT_FOUND", 404));
        return;
      }
      resolve(url);
    });
  });
}
function dec(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
var GIT_SUFFIX = /\.git$/i;
var SAFE_SEGMENT = /^[A-Za-z0-9_~.-]+$/;
function validateSegs(segs, raw) {
  if (segs.length < 2 || segs.some((s) => !s || s === "." || s === ".." || !SAFE_SEGMENT.test(s))) {
    throw new CallError(`Remote URL "${raw}" does not name a Bitbucket repository.`, "INVALID_REMOTE", 400);
  }
}
function splitCleanPath(cleanPath, isWeb, raw) {
  const segs = cleanPath.split("/").filter(Boolean);
  validateSegs(segs, raw);
  const slash = cleanPath.lastIndexOf("/");
  const dtoOwner = cleanPath.slice(0, slash);
  const slug = segs[segs.length - 1];
  const scmIdx = segs.findIndex((s) => s.toLowerCase() === "scm");
  if (scmIdx >= 0 && scmIdx + 2 === segs.length - 1) {
    const ctxHint = scmIdx > 0 ? `/${segs.slice(0, scmIdx).join("/")}` : "";
    return { dtoOwner, projectKey: segs[scmIdx + 1], slug, ctxHint };
  }
  if (segs.length === 2) {
    return { dtoOwner, projectKey: segs[0], slug, ctxHint: isWeb ? "" : null };
  }
  throw new CallError(`Remote URL "${raw}" is not a valid Bitbucket clone path.`, "INVALID_REMOTE", 400);
}
function parseRemote(url, originUrl) {
  const trimmed = url.trim();
  if (trimmed.includes("://")) {
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      throw new CallError(`Unsupported remote URL: ${trimmed}`, "INVALID_REMOTE", 400);
    }
    const isWeb = u.protocol === "https:" || u.protocol === "http:";
    if (!isWeb && u.protocol !== "ssh:") {
      throw new CallError(`Unsupported remote protocol: ${u.protocol}`, "INVALID_REMOTE", 400);
    }
    if (originUrl) {
      const matches = isWeb ? u.host.toLowerCase() === originUrl.host.toLowerCase() : u.hostname.toLowerCase() === originUrl.hostname.toLowerCase();
      if (!matches) {
        throw new CallError(`Remote "${trimmed}" does not belong to ${originUrl.origin}.`, "REMOTE_NOT_ON_INSTANCE", 404);
      }
    }
    const port = u.port ? Number.parseInt(u.port, 10) : u.protocol === "ssh:" ? 22 : u.protocol === "https:" ? 443 : 80;
    const cleanPath = dec(u.pathname).replace(/^\/+|\/+$/g, "").replace(GIT_SUFFIX, "");
    const parsed = splitCleanPath(cleanPath, isWeb, trimmed);
    return { hostname: u.hostname.toLowerCase(), port, ...parsed, raw: trimmed };
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) {
    const host = scp[1].toLowerCase();
    if (originUrl && host !== originUrl.hostname.toLowerCase()) {
      throw new CallError(`Remote "${trimmed}" does not belong to ${originUrl.origin}.`, "REMOTE_NOT_ON_INSTANCE", 404);
    }
    let cleanPath = dec(scp[2]).replace(/^\/+|\/+$/g, "").replace(GIT_SUFFIX, "");
    let port = 22;
    const portPrefix = /^(\d+)\/(.+)$/.exec(cleanPath);
    if (portPrefix) {
      port = Number.parseInt(portPrefix[1], 10);
      cleanPath = portPrefix[2];
    }
    const parsed = splitCleanPath(cleanPath, false, trimmed);
    return { hostname: host, port, ...parsed, raw: trimmed };
  }
  throw new CallError(`Unsupported remote URL: ${trimmed}`, "INVALID_REMOTE", 400);
}
function apiProjectKeyOfOwner(owner) {
  const trimmed = (owner ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  const segs = trimmed.split("/").filter(Boolean);
  const scmIdx = segs.findIndex((s) => s.toLowerCase() === "scm");
  if (scmIdx >= 0 && segs[scmIdx + 1]) return segs[scmIdx + 1];
  return segs[segs.length - 1];
}
function repoIdentFrom(selector, parsed, remoteName) {
  const selName = selector?.name || selector?.repo;
  if (selector && typeof selector.owner === "string" && selector.owner && typeof selName === "string" && selName) {
    return {
      dtoOwner: selector.owner,
      repo: selName,
      apiKey: apiProjectKeyOfOwner(selector.owner),
      dtoId: selector.id ? String(selector.id) : void 0,
      remoteName
    };
  }
  return {
    dtoOwner: parsed.dtoOwner,
    repo: parsed.slug,
    apiKey: parsed.projectKey,
    remoteName
  };
}

// src/bitbucket.ts
var BB = class {
  constructor(ctx, handle, forge2) {
    this.ctx = ctx;
    this.handle = handle;
    this.forge = forge2;
  }
  ctx;
  handle;
  forge;
  rest(path) {
    return `${this.ctx}/rest/api/latest${path}`;
  }
};
async function bbDo(bb, method, path, opts = {}) {
  let res;
  try {
    res = await bb.forge.request(bb.handle, {
      method,
      path,
      query: opts.query,
      headers: opts.headers,
      body: opts.body
    });
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      const e = err;
      const code = e.code && /^[A-Z_]{1,64}$/.test(e.code) ? e.code : "FORGE_UNREACHABLE";
      throw new CallError(`Outbound proxy refused the request: ${e.message}`, code);
    }
    throw new CallError(
      `Outbound request failed: ${err instanceof Error ? err.message : String(err)}`,
      "FORGE_UNREACHABLE"
    );
  }
  return { status: res.status, headers: res.headers, body: res.body };
}
async function bbGetJson(bb, path, query) {
  const res = await bbDo(bb, "GET", path, { query, headers: { accept: "application/json" } });
  return expectJson(res);
}
async function bbPostJson(bb, path, body, query) {
  const res = await bbDo(bb, "POST", path, {
    query,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return expectJson(res);
}
async function bbPutJson(bb, path, body, query) {
  const res = await bbDo(bb, "PUT", path, {
    query,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return expectJson(res);
}
async function bbDelete(bb, path, query) {
  const res = await bbDo(bb, "DELETE", path, { query, headers: { accept: "application/json" } });
  if (res.status >= 200 && res.status < 300) return res.status;
  throw httpError(res);
}
function httpError(res) {
  const json = parseJsonLoose(res.body);
  let apiMsg = null;
  if (json && typeof json === "object") {
    const obj = json;
    const firstErr = Array.isArray(obj.errors) ? obj.errors.find((e) => typeof e?.message === "string") : void 0;
    if (firstErr && typeof firstErr.message === "string") apiMsg = firstErr.message;
    else if (typeof obj.message === "string") apiMsg = obj.message;
  }
  const msg = apiMsg || `Bitbucket answered HTTP ${res.status}`;
  switch (res.status) {
    case 400:
      return new CallError(msg, "BAD_REQUEST", 400);
    case 401:
      return new CallError(msg, "UNAUTHORIZED", 401);
    case 403:
      return new CallError(msg, "FORBIDDEN", 403);
    case 404:
      return new CallError(msg, "NOT_FOUND", 404);
    case 409:
      return new CallError(msg, "CONFLICT", 409);
    case 422:
      return new CallError(msg, "UNPROCESSABLE", 422);
    default:
      return new CallError(msg, "FORGE_ERROR", res.status >= 400 && res.status <= 599 ? res.status : 502);
  }
}
function expectJson(res) {
  if (res.status >= 200 && res.status < 300) {
    if (!res.body) return {};
    const json = parseJsonLoose(res.body);
    if (json === null) throw new CallError("Bitbucket returned malformed JSON.", "MALFORMED_JSON", 502);
    return json;
  }
  throw httpError(res);
}
function parseJsonLoose(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
async function collectPages(bb, path, query, maxPages = 20) {
  const items = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await bbGetJson(bb, path, { ...query, start: String(start) });
    if (Array.isArray(res.values)) items.push(...res.values);
    if (res.isLastPage !== false) return { items, complete: true };
    if (typeof res.nextPageStart !== "number") return { items, complete: true };
    start = res.nextPageStart;
  }
  return { items, complete: false };
}

// src/mappers.ts
function mapForgeUser(u) {
  if (!u) return null;
  const login = (u.name ?? u.slug ?? "").trim();
  if (!login) return null;
  const id = typeof u.id === "number" && Number.isSafeInteger(u.id) && u.id > 0 ? u.id : u.slug ?? login;
  const out = { id, login };
  if (u.displayName) out.name = u.displayName;
  if (u.emailAddress) out.email = u.emailAddress;
  if (u.avatarUrl) out.avatarUrl = u.avatarUrl;
  return out;
}
function mapUser(u, identity) {
  const f = mapForgeUser(u);
  if (!f) return null;
  const out = {
    ...identity,
    id: String(f.id),
    username: f.login
  };
  if (f.name) out.name = f.name;
  if (f.email) out.email = f.email;
  if (f.avatarUrl) out.avatarUrl = f.avatarUrl;
  return out;
}
function webRepoUrl(origin, ctx, key, slug) {
  const enc2 = encodeURIComponent;
  if (key.startsWith("~")) {
    return `${origin}${ctx}/users/${enc2(key.slice(1))}/repos/${enc2(slug)}`;
  }
  return `${origin}${ctx}/projects/${enc2(key)}/repos/${enc2(slug)}`;
}
function webPrUrl(origin, ctx, key, slug, number) {
  return `${webRepoUrl(origin, ctx, key, slug)}/pull-requests/${number}`;
}
function sanitizeCloneUrl(rawUrl, instanceOrigin) {
  if (!rawUrl) return void 0;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return rawUrl;
    const base = new URL(instanceOrigin);
    base.pathname = u.pathname;
    base.search = "";
    base.hash = "";
    return base.href;
  } catch {
    return void 0;
  }
}
function mapProject(call, raw, dtoOwner, opts = {}) {
  const selfHref = raw.links?.self?.[0]?.href?.replace(/\/browse\/?$/, "");
  const rawHttpClone = raw.links?.clone?.find((c) => (c.name ?? "").toLowerCase() === "http")?.href;
  const httpClone = sanitizeCloneUrl(rawHttpClone, call.origin);
  const sshClone = raw.links?.clone?.find((c) => (c.name ?? "").toLowerCase() === "ssh")?.href;
  const proj = {
    ...call.identity,
    id: String(raw.id),
    owner: dtoOwner,
    name: raw.slug,
    url: selfHref || webRepoUrl(call.origin, call.ctx, raw.project?.key ?? dtoOwner, raw.slug)
  };
  if (httpClone) proj.cloneUrl = httpClone;
  if (sshClone) proj.sshUrl = sshClone;
  if (opts.defaultBranch) proj.defaultBranch = opts.defaultBranch;
  if (opts.remoteName !== void 0) proj.remoteName = opts.remoteName;
  return proj;
}
function mapPrState(pr) {
  const s = (pr.state ?? "").toUpperCase();
  if (s === "OPEN") return "open";
  if (s === "MERGED") return "merged";
  return "closed";
}
function assessMerge(draft, info) {
  if (!info) {
    return { canMerge: false, mergeable: null, mergeableState: "unknown", vetoes: [] };
  }
  const conflicted = info.conflicted === true || info.outcome === "CONFLICTED";
  const vetoes = Array.isArray(info.vetoes) ? info.vetoes : [];
  const clean = info.outcome === "CLEAN";
  return {
    canMerge: !draft && clean && !conflicted && vetoes.length === 0,
    mergeable: info.outcome === "UNKNOWN" && !conflicted ? null : !conflicted,
    mergeableState: conflicted ? "dirty" : vetoes.length > 0 ? "blocked" : clean ? "clean" : "unknown",
    vetoes
  };
}
function buildSubmitRequirements(assessment, openTaskCount) {
  if (!assessment) return [];
  const reqs = assessment.vetoes.map((v) => {
    const item = {
      name: v.summaryMessage || "Merge check",
      status: "unsatisfied"
    };
    if (v.detailedMessage) item.description = v.detailedMessage;
    return item;
  });
  const hasTaskVeto = assessment.vetoes.some(
    (v) => /task/i.test(v.summaryMessage ?? "") || /task/i.test(v.detailedMessage ?? "")
  );
  if (typeof openTaskCount === "number" && openTaskCount > 0 && !hasTaskVeto) {
    reqs.push({
      name: `Open tasks (${openTaskCount})`,
      status: "unsatisfied",
      description: "All pull request tasks must be resolved"
    });
  }
  return reqs;
}
function mapPull(call, raw, project, merge, headProject) {
  const state = mapPrState(raw);
  const prUrl = raw.links?.self?.[0]?.href?.replace(/\/overview\/?$/, "") ?? webPrUrl(call.origin, call.ctx, raw.toRef?.repository?.project?.key ?? project.owner, project.name, raw.id);
  const out = {
    ...call.identity,
    id: `${project.id}#${raw.id}`,
    number: Number(raw.id),
    project,
    title: raw.title ?? "",
    url: prUrl,
    state,
    draft: raw.draft === true,
    base: raw.toRef?.displayId ?? "",
    head: raw.fromRef?.displayId ?? "",
    author: mapUser(raw.author?.user, call.identity),
    labels: []
  };
  if (typeof raw.description === "string") out.body = raw.description;
  if (raw.fromRef?.latestCommit) out.headSha = raw.fromRef.latestCommit;
  const createdAt = iso(raw.createdDate);
  const updatedAt = iso(raw.updatedDate);
  if (createdAt) out.createdAt = createdAt;
  if (updatedAt) out.updatedAt = updatedAt;
  if (headProject) out.headProject = headProject;
  if (state === "open" && merge) {
    out.mergeable = merge.mergeable;
    out.mergeableState = merge.mergeableState;
  }
  return out;
}
function splitUnifiedDiff(diff) {
  const parts = /* @__PURE__ */ new Map();
  if (!diff) return parts;
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const plus = lines.find((l) => l.startsWith("+++ "));
    const minus = lines.find((l) => l.startsWith("--- "));
    const renamedFrom = lines.find((l) => l.startsWith("rename from "));
    const renamedTo = lines.find((l) => l.startsWith("rename to "));
    let path = "";
    if (plus && plus !== "+++ /dev/null") path = plus.slice(4).replace(/^b\//, "");
    else if (renamedTo) path = renamedTo.slice("rename to ".length);
    else if (minus && minus !== "--- /dev/null") path = minus.slice(4).replace(/^a\//, "");
    else path = /^diff --git a\/.+? b\/(.+)$/.exec(lines[0] ?? "")?.[1] ?? "";
    path = path.replace(/\t.*$/, "");
    if (!path) continue;
    let previousPath;
    if (renamedFrom) {
      previousPath = renamedFrom.slice("rename from ".length).replace(/\t.*$/, "");
    } else if (minus && minus !== "--- /dev/null") {
      const oldPath = minus.slice(4).replace(/^a\//, "").replace(/\t.*$/, "");
      if (oldPath && oldPath !== path) previousPath = oldPath;
    }
    let additions = 0;
    let deletions = 0;
    for (const l of lines) {
      if (l.startsWith("+") && !l.startsWith("+++")) additions += 1;
      else if (l.startsWith("-") && !l.startsWith("---")) deletions += 1;
    }
    const patch = chunk.endsWith("\n") ? chunk : `${chunk}
`;
    parts.set(path, { patch, additions, deletions, previousPath });
  }
  return parts;
}
function pathString(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  if (typeof p.toString === "string") return p.toString;
  if (Array.isArray(p.components)) return p.components.join("/");
  return "";
}
function mapChangedFiles(entries, patches) {
  const files = [];
  for (const entry of entries) {
    if (entry.nodeType === "DIRECTORY") continue;
    const filePath = pathString(entry.path) || pathString(entry.srcPath);
    if (!filePath) continue;
    const srcPath = pathString(entry.srcPath);
    const kind = (entry.type ?? "").toUpperCase();
    let status = "modified";
    if (kind === "ADD") status = "added";
    else if (kind === "DELETE") status = "removed";
    else if (kind === "MOVE" || kind === "COPY") status = "renamed";
    const chunk = patches.get(filePath) ?? (srcPath ? patches.get(srcPath) : void 0);
    const additions = chunk?.additions ?? 0;
    const deletions = chunk?.deletions ?? 0;
    const item = {
      path: filePath,
      status,
      additions,
      deletions,
      changes: additions + deletions
    };
    if (chunk?.patch) item.patch = chunk.patch;
    files.push(item);
  }
  if (files.length === 0 && patches.size > 0) {
    for (const [filePath, chunk] of patches) {
      files.push({
        path: filePath,
        status: chunk.previousPath ? "renamed" : "modified",
        additions: chunk.additions,
        deletions: chunk.deletions,
        changes: chunk.additions + chunk.deletions,
        patch: chunk.patch
      });
    }
  }
  return files;
}
function extractAnchor(activity, comment) {
  const anchor = activity.commentAnchor ?? comment.commentAnchor ?? comment.anchor;
  const p = anchor?.path || anchor?.srcPath;
  if (typeof p === "string" && p.length > 0) {
    return { path: p, line: typeof anchor?.line === "number" ? anchor.line : null };
  }
  return null;
}
function mapActivitiesToComments(activities, identity, prUrl, viewerLogin) {
  const issueComments = [];
  const reviewComments = [];
  const isMine = (author) => {
    if (!viewerLogin || !author) return false;
    return author.name === viewerLogin || author.slug === viewerLogin;
  };
  const childIds = /* @__PURE__ */ new Set();
  const collectChildren = (c) => {
    for (const reply of c.comments ?? []) {
      if (reply.id != null) childIds.add(String(reply.id));
      collectChildren(reply);
    }
  };
  const commentActivities = activities.filter(
    (a) => (a.action === "COMMENTED" || a.action === "REVIEW_COMMENTED") && a.comment
  );
  for (const activity of commentActivities) {
    collectChildren(activity.comment);
  }
  const visitedIds = /* @__PURE__ */ new Set();
  for (const activity of commentActivities) {
    const root = activity.comment;
    const rootId = String(root.id ?? "");
    if (!rootId || childIds.has(rootId) || visitedIds.has(rootId)) continue;
    const rootAnchor = extractAnchor(activity, root);
    const hasReplies = Array.isArray(root.comments) && root.comments.length > 0;
    const isThreaded = hasReplies || root.threadResolved !== void 0;
    const threadId = rootId || String(activity.id ?? "");
    const visit = (c, isFirst) => {
      const cid = String(c.id ?? "");
      if (!cid || visitedIds.has(cid)) return;
      visitedIds.add(cid);
      const replies = Array.isArray(c.comments) ? c.comments : [];
      const mine = isMine(c.author);
      const item = {
        ...identity,
        id: cid,
        url: `${prUrl}?commentId=${encodeURIComponent(cid)}`,
        body: c.text ?? "",
        author: mapUser(c.author, identity),
        canUpdate: mine,
        canDelete: mine && replies.length === 0
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
          canReply: false
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
  const byTime = (a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  issueComments.sort(byTime);
  reviewComments.sort(byTime);
  return { issueComments, reviewComments };
}
function mapVerdicts(pr, identity, prUrl) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of [...pr.reviewers ?? [], ...pr.participants ?? []]) {
    const u = entry.user;
    const key = u?.name ?? u?.slug ?? "";
    if (!key || seen.has(key)) continue;
    const st = (entry.status ?? "").toUpperCase();
    if (st !== "APPROVED" && st !== "NEEDS_WORK") continue;
    seen.add(key);
    const author = mapUser(u, identity);
    out.push({
      state: st === "APPROVED" ? "approved" : "changes_requested",
      ...author ? { author } : {},
      createdAt: null,
      url: prUrl
    });
  }
  return out;
}
function mapReviewers(pr, identity) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const r of pr.reviewers ?? []) {
    const mapped = mapUser(r.user, identity);
    if (!mapped || seen.has(mapped.username)) continue;
    seen.add(mapped.username);
    out.push(mapped);
  }
  return out;
}
function mapCommit(c, origin, ctx, key, slug) {
  if (!c.id) return null;
  const headline = (c.message ?? "").split(/\r?\n/)[0] ?? "";
  return {
    sha: c.id,
    headline,
    authorName: c.author?.displayName ?? c.author?.name ?? null,
    committedAt: iso(c.committerTimestamp ?? c.authorTimestamp) ?? null,
    url: `${webRepoUrl(origin, ctx, key, slug)}/commits/${encodeURIComponent(c.id)}`
  };
}
function mapCiStats(stats) {
  if (!stats) return null;
  const success = Number(stats.successful ?? 0);
  const pending = Number(stats.inProgress ?? 0);
  const failure = Number(stats.failed ?? 0) + Number(stats.cancelled ?? 0);
  const unknown = Number(stats.unknown ?? 0);
  const total = success + pending + failure + unknown;
  if (total === 0) return null;
  const state = failure > 0 ? "failure" : pending > 0 ? "pending" : success > 0 ? "success" : "unknown";
  return { state, total, success, failure, pending };
}
function mapCiRuns(runs, identity) {
  if (runs.length === 0) return null;
  let success = 0;
  let failure = 0;
  let pending = 0;
  const mappedRuns = runs.map((r, idx) => {
    const st = (r.state ?? "").toUpperCase();
    const isPending = st === "INPROGRESS";
    const isSuccess = st === "SUCCESSFUL";
    const isFail = st === "FAILED" || st === "CANCELLED";
    if (isSuccess) success += 1;
    else if (isFail) failure += 1;
    else if (isPending) pending += 1;
    const run = {
      ...identity,
      id: String(r.key ?? `build-${idx}`),
      name: r.name || r.key || "Build",
      status: isPending ? "in_progress" : "completed",
      conclusion: isSuccess ? "success" : isFail ? "failure" : null
    };
    if (r.url && /^https?:\/\//i.test(r.url)) run.detailsUrl = r.url;
    if (r.description) run.output = { title: r.description };
    const started = iso(r.createdDate ?? r.dateAdded);
    const updated = iso(r.updatedDate);
    if (started) run.startedAt = started;
    if (!isPending && updated) run.completedAt = updated;
    return run;
  });
  const state = failure > 0 ? "failure" : pending > 0 ? "pending" : success > 0 ? "success" : "unknown";
  return {
    summary: { state, total: runs.length, success, failure, pending },
    runs: mappedRuns
  };
}
function computeStack(branchPr, allOpen, repoId, urlFor) {
  const sameRepoOpen = allOpen.filter(
    (p) => p.fromRef?.repository?.id === repoId && p.toRef?.repository?.id === repoId && mapPrState(p) === "open"
  );
  const visited = /* @__PURE__ */ new Set([branchPr.id]);
  let bottom = branchPr;
  for (let i = 0; i < 32; i++) {
    const baseBranch = bottom.toRef?.displayId;
    if (!baseBranch) break;
    const below = sameRepoOpen.find((p) => !visited.has(p.id) && p.fromRef?.displayId === baseBranch);
    if (!below) break;
    visited.add(below.id);
    bottom = below;
  }
  const chain = [bottom];
  const inChain = /* @__PURE__ */ new Set([bottom.id]);
  let cursor = bottom;
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
    base: bottom.toRef?.displayId ?? "",
    layers: chain.map((p) => ({
      number: Number(p.id),
      title: p.title ?? `#${p.id}`,
      url: urlFor(p),
      state: mapPrState(p),
      draft: p.draft === true,
      head: p.fromRef?.displayId ?? ""
    }))
  };
}

// src/main.ts
var PAGE_SIZE = 25;
var COMMIT_SHA = /^[0-9a-f]{40}$/i;
function enc(value) {
  return encodeURIComponent(value);
}
function repoApiPath(ctx, key, slug) {
  return `${ctx}/rest/api/latest/projects/${enc(key)}/repos/${enc(slug)}`;
}
function selectorOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value;
  const owner = typeof obj.owner === "string" ? obj.owner : void 0;
  const name = typeof obj.name === "string" ? obj.name : typeof obj.repo === "string" ? obj.repo : void 0;
  const id = typeof obj.id === "string" ? obj.id : void 0;
  return owner && name ? { id, owner, name } : null;
}
function isLinkedRead(input) {
  if (input.linked === true) return true;
  if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) return false;
  return input.context.linked === true;
}
async function fetchRepo(bb, ident) {
  const tryKey = async (key) => {
    const repo = await bbGetJson(bb, repoApiPath(bb.ctx, key, ident.repo));
    if (typeof repo.id !== "number" || typeof repo.slug !== "string") {
      throw new CallError("Bitbucket returned an invalid repository payload.", "MALFORMED_REPO", 502);
    }
    return { repo, apiKey: repo.project?.key ?? key };
  };
  try {
    return await tryKey(ident.apiKey);
  } catch (err) {
    if (!(err instanceof CallError) || err.status !== 404) throw err;
    const alt = ident.apiKey.startsWith("~") ? ident.apiKey.slice(1) : `~${ident.apiKey}`;
    try {
      return await tryKey(alt);
    } catch {
      throw err;
    }
  }
}
async function fetchDefaultBranch(bb, key, slug) {
  try {
    const db = await bbGetJson(bb, `${repoApiPath(bb.ctx, key, slug)}/default-branch`);
    return typeof db.displayId === "string" && db.displayId ? db.displayId : null;
  } catch (err) {
    if (err instanceof CallError && err.status === 404) return null;
    throw err;
  }
}
async function resolveBoundRepo(call, input, explicitSelector, opts = {}) {
  const { includeDefaultBranch = false, allowLinked = false } = opts;
  const directory = typeof input.directory === "string" ? input.directory : "";
  const remoteName = typeof input.remote === "string" && input.remote ? input.remote : "origin";
  if (allowLinked && explicitSelector && isLinkedRead(input)) {
    const wantedOwner = (explicitSelector.owner ?? "").trim();
    const wantedKey2 = apiProjectKeyOfOwner(wantedOwner);
    const wantedSlug2 = (explicitSelector.name ?? explicitSelector.repo ?? "").trim();
    if (!wantedKey2 || !wantedSlug2) {
      throw new CallError("Invalid repository selector.", "BAD_REQUEST", 400);
    }
    let ctxHint = null;
    if (directory && store.get(call.origin) === void 0) {
      try {
        ctxHint = parseRemote(await readRemoteUrl(directory, remoteName), call.originUrl).ctxHint;
      } catch {
        ctxHint = null;
      }
    }
    const det2 = await detectContextPath({
      store,
      forge: call.forge,
      handle: call.handle,
      origin: call.origin,
      hint: ctxHint
    });
    call.ctx = det2.ctx;
    const bb2 = new BB(det2.ctx, call.handle, call.forge);
    const linkedIdent = {
      dtoOwner: wantedOwner,
      repo: wantedSlug2,
      apiKey: wantedKey2
    };
    const linkedGot = await fetchRepo(bb2, linkedIdent);
    const linkedDefault = includeDefaultBranch ? await fetchDefaultBranch(bb2, linkedGot.apiKey, linkedGot.repo.slug) : null;
    return {
      bb: bb2,
      ident: linkedIdent,
      raw: linkedGot.repo,
      apiKey: linkedGot.apiKey,
      project: mapProject(call, linkedGot.repo, wantedOwner, { defaultBranch: linkedDefault }),
      defaultBranch: linkedDefault
    };
  }
  const rawRemote = await readRemoteUrl(directory, remoteName);
  const parsed = parseRemote(rawRemote, call.originUrl);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
    hint: parsed.ctxHint
  });
  call.ctx = det.ctx;
  const bb = new BB(det.ctx, call.handle, call.forge);
  const primaryIdent = repoIdentFrom(null, parsed, remoteName);
  const primaryGot = await fetchRepo(bb, primaryIdent);
  const defaultBranch = includeDefaultBranch ? await fetchDefaultBranch(bb, primaryGot.apiKey, primaryGot.repo.slug) : null;
  const primaryProject = mapProject(call, primaryGot.repo, primaryIdent.dtoOwner, {
    defaultBranch,
    remoteName
  });
  if (!explicitSelector) {
    return {
      bb,
      ident: primaryIdent,
      raw: primaryGot.repo,
      apiKey: primaryGot.apiKey,
      project: primaryProject,
      defaultBranch
    };
  }
  const wantedKey = apiProjectKeyOfOwner(explicitSelector.owner ?? "");
  const wantedSlug = explicitSelector.name ?? explicitSelector.repo ?? "";
  const isPersonalRepo = primaryGot.apiKey.startsWith("~") || primaryGot.repo.project?.type === "PERSONAL";
  const sameKey = isPersonalRepo ? wantedKey.replace(/^~/, "").toLowerCase() === primaryGot.apiKey.replace(/^~/, "").toLowerCase() : wantedKey.toLowerCase() === primaryGot.apiKey.toLowerCase();
  if (sameKey && wantedSlug.toLowerCase() === primaryGot.repo.slug.toLowerCase()) {
    const project = mapProject(call, primaryGot.repo, explicitSelector.owner ?? primaryIdent.dtoOwner, {
      defaultBranch
    });
    return {
      bb,
      ident: { ...primaryIdent, dtoOwner: project.owner },
      raw: primaryGot.repo,
      apiKey: primaryGot.apiKey,
      project,
      defaultBranch
    };
  }
  const originRepo = primaryGot.repo.origin;
  if (originRepo && originRepo.project?.key?.toLowerCase() === wantedKey.toLowerCase() && originRepo.slug?.toLowerCase() === wantedSlug.toLowerCase()) {
    const upstreamIdent = {
      dtoOwner: explicitSelector.owner ?? originRepo.project.key,
      repo: originRepo.slug,
      apiKey: originRepo.project.key
    };
    const upstreamGot = await fetchRepo(bb, upstreamIdent);
    const upDefault = includeDefaultBranch ? await fetchDefaultBranch(bb, upstreamGot.apiKey, upstreamGot.repo.slug) : null;
    return {
      bb,
      ident: upstreamIdent,
      raw: upstreamGot.repo,
      apiKey: upstreamGot.apiKey,
      project: mapProject(call, upstreamGot.repo, upstreamIdent.dtoOwner, { defaultBranch: upDefault }),
      defaultBranch: upDefault
    };
  }
  throw new CallError(
    `Repository "${wantedKey}/${wantedSlug}" is outside the bound repository network.`,
    "NOT_IN_NETWORK",
    404
  );
}
async function fetchPr(bb, key, slug, number) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CallError("Pull request number must be a positive integer.", "BAD_REQUEST", 400);
  }
  const pr = await bbGetJson(bb, `${repoApiPath(bb.ctx, key, slug)}/pull-requests/${number}`, {
    withProperties: "true"
  });
  if (typeof pr.id !== "number" || typeof pr.version !== "number") {
    throw new CallError("Bitbucket returned an invalid pull request payload.", "MALFORMED_PR", 502);
  }
  return pr;
}
async function fetchMergeability(bb, key, slug, number) {
  try {
    return await bbGetJson(bb, `${repoApiPath(bb.ctx, key, slug)}/pull-requests/${number}/merge`);
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
    return null;
  }
}
async function fetchCiFast(bb, sha) {
  if (!sha) return null;
  try {
    const stats = await bbGetJson(bb, `${bb.ctx}/rest/build-status/latest/commits/stats/${enc(sha)}`);
    const mapped = mapCiStats(stats);
    if (mapped) return { summary: mapped };
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
  }
  try {
    const runs = await bbGetJson(bb, `${bb.ctx}/rest/build-status/latest/commits/${enc(sha)}`, {
      limit: "50"
    });
    const mapped = mapCiRuns(Array.isArray(runs.values) ? runs.values : [], { provider: "", instance: "" });
    return mapped ? { summary: mapped.summary } : null;
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
    return null;
  }
}
async function fetchCiDetailed(call, bb, sha) {
  if (!sha) return null;
  try {
    const page = await bbGetJson(bb, `${bb.ctx}/rest/build-status/latest/commits/${enc(sha)}`, {
      limit: "50"
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
async function fetchDiffText(bb, key, slug, number) {
  const res = await bbDo(bb, "GET", `${repoApiPath(bb.ctx, key, slug)}/pull-requests/${number}.diff`, {
    query: { contextLines: "3" },
    headers: { accept: "text/plain" }
  });
  if (res.status === 401) throw new CallError("Unauthorized", "UNAUTHORIZED", 401);
  if (res.status === 404) throw new CallError(`Pull request #${number} was not found.`, "NOT_FOUND", 404);
  if (res.status < 200 || res.status >= 300) {
    throw new CallError(`Bitbucket answered HTTP ${res.status} on pull request diff.`, "FORGE_ERROR", res.status);
  }
  return res.body;
}
async function findUserByIdentifier(bb, who) {
  try {
    const page = await bbGetJson(bb, bb.rest("/users"), { filter: who, limit: "25" });
    const values = Array.isArray(page.values) ? page.values : [];
    const exact = values.find((u) => u.name === who || u.slug === who);
    if (exact) return exact;
  } catch (err) {
    if (err instanceof CallError && err.status === 401) throw err;
  }
  try {
    return await bbGetJson(bb, bb.rest(`/users/${enc(who)}`));
  } catch (err) {
    if (err instanceof CallError && err.status === 404) return null;
    throw err;
  }
}
async function hAuthProbe(req) {
  const call = makeCall(req);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
    forceProbe: true
  });
  if (det.basis === "none") {
    return { supported: false, message: "No Bitbucket Data Center API found at this origin." };
  }
  const version = typeof det.props?.version === "string" && det.props.version ? det.props.version : void 0;
  return version ? { supported: true, version } : { supported: true };
}
async function hAuthVerify(req) {
  const call = makeCall(req);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin,
    forceProbe: true
  });
  if (det.basis === "none") {
    throw new CallError("No Bitbucket Data Center API found at this origin.", "NOT_BITBUCKET", 400);
  }
  const bb = new BB(det.ctx, call.handle, call.forge);
  await bbGetJson(bb, bb.rest("/inbox/pull-requests/count"));
  let whoami = null;
  const whoRes = await bbDo(bb, "GET", `${bb.ctx}/plugins/servlet/applinks/whoami`, {
    headers: { accept: "text/plain" }
  });
  if (whoRes.status === 401) throw new CallError("Invalid access token.", "UNAUTHORIZED", 401);
  if (whoRes.status === 200) whoami = whoRes.body.trim() || null;
  let user = whoami ? await findUserByIdentifier(bb, whoami) : null;
  if (!user) {
    const dash = await bbGetJson(bb, bb.rest("/dashboard/pull-requests"), {
      role: "AUTHOR",
      limit: "1"
    });
    user = Array.isArray(dash.values) ? dash.values[0]?.author?.user ?? null : null;
  }
  const mapped = mapForgeUser(user);
  if (!mapped) {
    throw new CallError("Could not resolve the Bitbucket user for this token.", "USER_NOT_FOUND", 502);
  }
  return { user: mapped };
}
async function hUnsupported(_req) {
  throw new CallError("This operation is not supported for Bitbucket Data Center.", "UNSUPPORTED", 501);
}
async function hChangeRequestStatus(req) {
  const call = makeCall(req);
  const input = req.input;
  const branch = String(input.branch ?? "");
  const remoteName = typeof input.remote === "string" && input.remote ? input.remote : null;
  const { bb, raw, apiKey, project, defaultBranch } = await resolveBoundRepo(call, input, null, {
    includeDefaultBranch: true
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
      stack: null
    };
  }
  const prPath = `${repoApiPath(bb.ctx, apiKey, raw.slug)}/pull-requests`;
  const outgoing = await bbGetJson(bb, prPath, {
    at: `refs/heads/${branch}`,
    direction: "OUTGOING",
    state: "ALL",
    limit: "50"
  });
  const candidates = (Array.isArray(outgoing.values) ? outgoing.values : []).filter(
    (pr) => pr.fromRef?.id === `refs/heads/${branch}` && pr.fromRef?.repository?.id === raw.id
  );
  const picked = candidates.find((pr) => mapPrState(pr) === "open") ?? candidates.slice().sort((a, b) => (b.updatedDate ?? 0) - (a.updatedDate ?? 0))[0] ?? null;
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
      stack: null
    };
  }
  const state = mapPrState(picked);
  const mergeInfo = state === "open" ? await fetchMergeability(bb, apiKey, raw.slug, picked.id) : null;
  const assessment = state === "open" ? assessMerge(picked.draft === true, mergeInfo) : void 0;
  const ci = state === "open" ? await fetchCiFast(bb, picked.fromRef?.latestCommit) : null;
  let stack = null;
  if (state === "open") {
    const openRes = await collectPages(bb, prPath, { state: "OPEN", limit: "50" }, 5);
    stack = computeStack(
      picked,
      openRes.items,
      raw.id,
      (p) => p.links?.self?.[0]?.href?.replace(/\/overview\/?$/, "") ?? webPrUrl(call.origin, bb.ctx, apiKey, raw.slug, p.id)
    );
  }
  return {
    identity: call.identity,
    fetchedAt: Date.now(),
    project,
    branch,
    changeRequest: mapPull(call, picked, project, assessment),
    ci,
    ...state === "open" && assessment ? { canMerge: assessment.canMerge } : {},
    defaultBranch,
    resolvedRemoteName: remoteName,
    stack
  };
}
async function hListChangeRequests(req) {
  const call = makeCall(req);
  const input = req.input;
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, input);
  const login = call.user?.login ?? "";
  const stateMap = { open: "OPEN", closed: "DECLINED", merged: "MERGED", all: "ALL" };
  const params = {
    state: stateMap[String(input.state ?? "open")] ?? "OPEN",
    limit: String(PAGE_SIZE),
    withProperties: "false",
    withAttributes: "false"
  };
  if (typeof input.query === "string" && input.query.trim()) {
    params.filterText = input.query.trim();
  }
  const people = String(input.people ?? "any");
  if (people === "created" && login) {
    params["username.1"] = login;
    params["role.1"] = "AUTHOR";
  } else if (people === "reviewRequested" && login) {
    params["username.1"] = login;
    params["role.1"] = "REVIEWER";
  }
  const rawPage = Number(input.page ?? 1);
  const wantedPage = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const MAX_LIST_PAGES = 50;
  if (wantedPage > MAX_LIST_PAGES) {
    return { items: [], page: wantedPage, hasMore: false };
  }
  const listPath = `${repoApiPath(bb.ctx, apiKey, raw.slug)}/pull-requests`;
  let start = 0;
  let last = { values: [], isLastPage: true };
  for (let p = 1; p <= wantedPage; p++) {
    last = await bbGetJson(bb, listPath, { ...params, start: String(start) });
    if (p < wantedPage) {
      if (last.isLastPage !== false || typeof last.nextPageStart !== "number") {
        return { items: [], page: wantedPage, hasMore: false };
      }
      start = last.nextPageStart;
    }
  }
  const values = Array.isArray(last.values) ? last.values : [];
  const items = values.map((pr) => {
    const headRepo = pr.fromRef?.repository;
    const isFork = headRepo && typeof headRepo.id === "number" && headRepo.id !== raw.id;
    const headProject = isFork ? mapProject(call, headRepo, headRepo.project?.key ?? project.owner) : null;
    return mapPull(call, pr, project, void 0, headProject);
  });
  return { items, page: wantedPage, hasMore: last.isLastPage === false };
}
async function hChangeRequestContext(req) {
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
  const isOpen = state === "open";
  const headSha = pr.fromRef?.latestCommit;
  const repoBase = repoApiPath(bb.ctx, apiKey, raw.slug);
  const [mergeInfo, activitiesRes, diffText, changesRes, ci, commitsRes, openPrsRes] = await Promise.all([
    isOpen ? fetchMergeability(bb, apiKey, raw.slug, number) : Promise.resolve(null),
    collectPages(bb, `${repoBase}/pull-requests/${number}/activities`, { limit: "100" }),
    includeDiff ? fetchDiffText(bb, apiKey, raw.slug, number) : Promise.resolve(""),
    includeDiff ? bbGetJson(bb, `${repoBase}/pull-requests/${number}/changes`, {
      changeScope: "ALL",
      withComments: "false",
      limit: "1000"
    }) : Promise.resolve({ values: [] }),
    includeCIDetails ? fetchCiDetailed(call, bb, headSha) : fetchCiFast(bb, headSha),
    includeTimeline ? bbGetJson(bb, `${repoBase}/pull-requests/${number}/commits`, { limit: "50" }) : Promise.resolve(null),
    isOpen ? collectPages(bb, `${repoBase}/pull-requests`, { state: "OPEN", limit: "50" }, 5).catch(
      () => null
    ) : Promise.resolve(null)
  ]);
  const assessment = isOpen ? assessMerge(pr.draft === true, mergeInfo) : void 0;
  const headRepo = pr.fromRef?.repository;
  const headProject = headRepo && typeof headRepo.id === "number" && headRepo.id !== raw.id ? mapProject(call, headRepo, headRepo.project?.key ?? project.owner) : null;
  const changeRequest = mapPull(call, pr, project, assessment, headProject);
  const prUrl = String(changeRequest.url);
  const { issueComments, reviewComments } = mapActivitiesToComments(
    activitiesRes.items,
    call.identity,
    prUrl,
    call.user?.login ?? null
  );
  const patches = splitUnifiedDiff(diffText);
  const files = includeDiff ? mapChangedFiles(Array.isArray(changesRes.values) ? changesRes.values : [], patches) : [];
  const submitRequirements = isOpen ? buildSubmitRequirements(assessment, pr.properties?.openTaskCount) : [];
  const stack = isOpen && openPrsRes ? computeStack(
    pr,
    openPrsRes.items,
    raw.id,
    (p) => p.links?.self?.[0]?.href?.replace(/\/overview\/?$/, "") ?? webPrUrl(call.origin, bb.ctx, apiKey, raw.slug, p.id)
  ) : null;
  const out = {
    identity: call.identity,
    project,
    changeRequest,
    issueComments,
    reviewComments,
    files,
    diff: diffText,
    ci,
    submitRequirements
  };
  if (stack) out.stack = stack;
  if (includeTimeline && commitsRes) {
    const rawCommits = Array.isArray(commitsRes.values) ? commitsRes.values : [];
    out.commits = rawCommits.map((c) => mapCommit(c, call.origin, bb.ctx, apiKey, raw.slug)).filter((c) => c !== null).reverse();
    out.commitsComplete = commitsRes.isLastPage !== false;
    out.reviewers = mapReviewers(pr, call.identity);
    out.verdicts = mapVerdicts(pr, call.identity, prUrl);
  }
  return out;
}
async function hProjectUpstream(req) {
  const call = makeCall(req);
  const { bb, raw } = await resolveBoundRepo(call, req.input);
  const originRepo = raw.origin;
  if (!originRepo || typeof originRepo.slug !== "string" || !originRepo.project?.key) {
    return { identity: call.identity, isFork: false, upstream: null };
  }
  const upIdent = {
    dtoOwner: originRepo.project.key,
    repo: originRepo.slug,
    apiKey: originRepo.project.key
  };
  const upGot = await fetchRepo(bb, upIdent);
  const defaultBranch = await fetchDefaultBranch(bb, upGot.apiKey, upGot.repo.slug);
  return {
    identity: call.identity,
    isFork: true,
    upstream: mapProject(call, upGot.repo, upGot.apiKey, { defaultBranch })
  };
}
async function hProjectBranches(req) {
  const call = makeCall(req);
  const selector = selectorOf(req.input.project);
  const { bb, raw, apiKey } = await resolveBoundRepo(call, req.input, selector);
  const { items } = await collectPages(
    bb,
    `${repoApiPath(bb.ctx, apiKey, raw.slug)}/branches`,
    { orderBy: "MODIFICATION", limit: "100" },
    5
  );
  return items.map((b) => b.displayId ?? "").filter(Boolean);
}
async function hListReviewerCandidates(req) {
  const call = makeCall(req);
  const selector = selectorOf(req.input.project);
  const { bb, raw, apiKey } = await resolveBoundRepo(call, req.input, selector);
  const page = await bbGetJson(bb, bb.rest("/users"), {
    "permission.1": "REPO_READ",
    "permission.1.projectKey": apiKey,
    "permission.1.repositorySlug": raw.slug,
    limit: "100"
  });
  const values = Array.isArray(page.values) ? page.values : [];
  return values.filter((u) => u.active !== false && u.type !== "SERVICE").map((u) => {
    const f = mapForgeUser(u);
    if (!f) return null;
    return f.avatarUrl ? { id: String(f.id), login: f.login, avatarUrl: f.avatarUrl } : { id: String(f.id), login: f.login };
  }).filter((u) => u !== null);
}
async function hReadChangeRequestPatch(req) {
  const call = makeCall(req);
  const selector = selectorOf(req.input.sourceRepo);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, req.input, selector, { allowLinked: true });
  const number = Number(req.input.number ?? 0);
  const patch = await fetchDiffText(bb, apiKey, raw.slug, number);
  return { patch, meta: { owner: project.owner, repo: project.name, number } };
}
function encodeFileSegments(filePath) {
  const segs = filePath.split("/");
  if (segs.some((s) => !s || s === "." || s === "..")) {
    throw new CallError(`Invalid file path "${filePath}".`, "BAD_REQUEST", 400);
  }
  return segs.map(enc).join("/");
}
async function hReadChangeRequestFile(req) {
  const call = makeCall(req);
  const input = req.input;
  const selector = selectorOf(input.sourceRepo);
  const { bb, raw, apiKey } = await resolveBoundRepo(call, input, selector, { allowLinked: true });
  const number = Number(input.number ?? 0);
  const pr = await fetchPr(bb, apiKey, raw.slug, number);
  const headSha = pr.fromRef?.latestCommit ?? "";
  const toSha = pr.toRef?.latestCommit ?? "";
  if (!COMMIT_SHA.test(headSha) || !COMMIT_SHA.test(toSha)) {
    throw new CallError("Bitbucket returned invalid pull request commit SHAs.", "MALFORMED_PR", 502);
  }
  const srcKey = pr.fromRef?.repository?.project?.key ?? apiKey;
  const srcSlug = pr.fromRef?.repository?.slug ?? raw.slug;
  const sameRepo = (pr.fromRef?.repository?.id ?? raw.id) === raw.id;
  let baseSha = toSha;
  const mbRepos = sameRepo ? [[apiKey, raw.slug]] : [
    [srcKey, srcSlug],
    [apiKey, raw.slug]
  ];
  for (const [mbKey, mbSlug] of mbRepos) {
    try {
      const mbRes = await bbDo(bb, "GET", `${repoApiPath(bb.ctx, mbKey, mbSlug)}/commits/${enc(headSha)}/merge-base`, {
        query: { otherCommitId: toSha },
        headers: { accept: "application/json" }
      });
      if (mbRes.status === 401) throw new CallError("Unauthorized", "UNAUTHORIZED", 401);
      if (mbRes.status === 200 && mbRes.body) {
        const parsed = parseJsonLoose(mbRes.body);
        if (parsed && typeof parsed.id === "string" && COMMIT_SHA.test(parsed.id)) {
          baseSha = parsed.id;
          break;
        }
      }
    } catch (err) {
      if (err instanceof CallError && err.status === 401) throw err;
    }
  }
  const readRaw = async (repoKey, repoSlug, filePath2, atSha) => {
    const res = await bbDo(bb, "GET", `${repoApiPath(bb.ctx, repoKey, repoSlug)}/raw/${encodeFileSegments(filePath2)}`, {
      query: { at: atSha },
      headers: { accept: "text/plain" }
    });
    if (res.status === 200) return res.body;
    if (res.status === 404) return "";
    if (res.status === 401) throw new CallError("Unauthorized", "UNAUTHORIZED", 401);
    throw new CallError(`Bitbucket answered HTTP ${res.status} reading raw file.`, "FORGE_ERROR", res.status);
  };
  const filePath = String(input.path ?? "");
  const previousPath = typeof input.previousPath === "string" && input.previousPath ? input.previousPath : filePath;
  const status = String(input.status ?? "M").toUpperCase();
  const [original, modified] = await Promise.all([
    status === "A" ? Promise.resolve("") : readRaw(apiKey, raw.slug, previousPath, baseSha),
    status === "D" ? Promise.resolve("") : readRaw(srcKey, srcSlug, filePath, headSha)
  ]);
  return { original, modified };
}
async function hLiveSummaries(req) {
  const call = makeCall(req);
  const det = await detectContextPath({
    store,
    forge: call.forge,
    handle: call.handle,
    origin: call.origin
  });
  const bb = new BB(det.ctx, call.handle, call.forge);
  const refs = Array.isArray(req.input.refs) ? req.input.refs : [];
  const rows = await Promise.all(
    refs.map(async (ref) => {
      const owner = typeof ref.owner === "string" ? ref.owner : "";
      const repo = typeof ref.repo === "string" ? ref.repo : "";
      const number = Number(ref.number ?? 0);
      if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) return null;
      const keyCandidates = [apiProjectKeyOfOwner(owner)];
      if (!keyCandidates[0].startsWith("~")) keyCandidates.push(`~${keyCandidates[0]}`);
      try {
        let pr = null;
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
        const isOpen = state === "open";
        const [mergeInfo, ci] = isOpen ? await Promise.all([
          fetchMergeability(bb, usedKey, repo, number),
          fetchCiFast(bb, pr.fromRef?.latestCommit)
        ]) : [null, null];
        const assessment = isOpen ? assessMerge(pr.draft === true, mergeInfo) : null;
        return {
          owner,
          repo,
          number: Number(pr.id),
          state,
          draft: pr.draft === true,
          title: pr.title ?? "",
          mergeable: assessment ? assessment.mergeable : null,
          mergeableState: assessment ? assessment.mergeableState : null,
          checks: isOpen && ci ? ci.summary : null,
          ...pr.fromRef?.latestCommit ? { headSha: pr.fromRef.latestCommit } : {},
          ...pr.toRef?.displayId ? { base: pr.toRef.displayId } : {}
        };
      } catch (err) {
        if (err instanceof CallError && err.status === 401) throw err;
        return null;
      }
    })
  );
  return {
    summaries: rows.filter((r) => r !== null),
    issueSummaries: []
  };
}
async function hReadChangeRequestHead(req) {
  const call = makeCall(req);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(call, req.input);
  const pr = await fetchPr(bb, apiKey, raw.slug, Number(req.input.number ?? 0));
  const headSha = (pr.fromRef?.latestCommit ?? "").toLowerCase();
  if (!COMMIT_SHA.test(headSha)) {
    throw new CallError("Bitbucket did not report a valid 40-char head commit SHA.", "HEAD_SHA_MISSING", 502);
  }
  const sameRepo = (pr.fromRef?.repository?.id ?? raw.id) === raw.id;
  const headOwner = sameRepo ? project.owner : pr.fromRef?.repository?.project?.key ?? project.owner;
  return {
    project: { id: project.id, owner: project.owner, name: project.name },
    headSha,
    headBranch: pr.fromRef?.displayId ?? "",
    headOwner
  };
}
function normalizeCloneEndpointOnInstance(rawCloneUrl, instanceOrigin) {
  if (!rawCloneUrl) return null;
  try {
    const parsed = new URL(rawCloneUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const clean = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    const slash = clean.lastIndexOf("/");
    if (slash <= 0) return null;
    const owner = clean.slice(0, slash);
    const name = clean.slice(slash + 1);
    if (!owner || !name) return null;
    const target = new URL(instanceOrigin);
    target.pathname = parsed.pathname.endsWith(".git") ? parsed.pathname : `${parsed.pathname.replace(/\/+$/, "")}.git`;
    target.search = "";
    target.hash = "";
    return { endpoint: target.href, owner, name };
  } catch {
    return null;
  }
}
async function hResolveChangeRequestSource(req) {
  const call = makeCall(req);
  const input = req.input;
  const targetSel = selectorOf(input.project);
  if (!targetSel) throw new CallError("Target project is required.", "BAD_REQUEST", 400);
  const { bb, raw, apiKey, project: targetProject } = await resolveBoundRepo(call, input, targetSel);
  const pr = await fetchPr(bb, apiKey, raw.slug, Number(input.number ?? 0));
  const actualSha = (pr.fromRef?.latestCommit ?? "").toLowerCase();
  const expectedSha = String(input.expectedHeadSha ?? "").toLowerCase();
  if (!COMMIT_SHA.test(actualSha)) {
    throw new CallError("Bitbucket did not report a valid head commit SHA.", "HEAD_SHA_MISSING", 502);
  }
  if (expectedSha && actualSha !== expectedSha) {
    throw new CallError("The pull request head commit changed.", "SOURCE_CONTROL_CHANGE_REQUEST_STALE", 409);
  }
  const srcRefRepo = pr.fromRef?.repository;
  const srcKey = srcRefRepo?.project?.key ?? apiKey;
  const srcSlug = srcRefRepo?.slug ?? raw.slug;
  const sameRepo = (srcRefRepo?.id ?? raw.id) === raw.id;
  let rawHttpClone = srcRefRepo?.links?.clone?.find((c) => (c.name ?? "").toLowerCase() === "http")?.href;
  let srcRepoId = srcRefRepo?.id ?? raw.id;
  if (!rawHttpClone) {
    const fullSrc = sameRepo ? raw : (await fetchRepo(bb, { dtoOwner: srcKey, repo: srcSlug, apiKey: srcKey })).repo;
    srcRepoId = fullSrc.id;
    rawHttpClone = fullSrc.links?.clone?.find((c) => (c.name ?? "").toLowerCase() === "http")?.href;
  }
  const fallbackClone = `${call.origin}${bb.ctx}/scm/${enc(srcKey.toLowerCase())}/${enc(srcSlug)}.git`;
  const normalized = normalizeCloneEndpointOnInstance(rawHttpClone, call.origin) ?? normalizeCloneEndpointOnInstance(fallbackClone, call.origin);
  if (!normalized) {
    throw new CallError("Bitbucket reported an invalid HTTPS clone URL for the source repository.", "MALFORMED_REPO", 502);
  }
  return {
    sourceProject: {
      id: String(srcRepoId),
      owner: normalized.owner,
      name: normalized.name
    },
    targetProject: {
      id: targetProject.id,
      owner: targetSel.owner ?? targetProject.owner,
      name: targetSel.name ?? targetProject.name
    },
    classification: sameRepo ? "same-repository" : "contributor-fork",
    headSha: actualSha,
    headRef: pr.fromRef?.id ?? `refs/heads/${pr.fromRef?.displayId ?? ""}`,
    endpoint: normalized.endpoint
  };
}
function readProviderTarget(input) {
  const resolved = input.resolved ?? {};
  const rawPt = resolved.providerTarget ?? {};
  const target = resolved.target ?? {};
  const key = typeof rawPt.key === "string" ? rawPt.key : "";
  const slug = typeof rawPt.slug === "string" ? rawPt.slug : "";
  if (!key || !slug) {
    throw new CallError("Resolved mutation target is missing repository coordinates.", "BAD_REQUEST", 400);
  }
  return {
    pt: {
      ctx: typeof rawPt.ctx === "string" ? normalizeCtx(rawPt.ctx) : "",
      repoId: Number(rawPt.repoId ?? 0),
      key,
      slug,
      dtoOwner: typeof rawPt.dtoOwner === "string" ? rawPt.dtoOwner : key,
      number: typeof rawPt.number === "number" ? rawPt.number : void 0,
      sourceRepoId: typeof rawPt.sourceRepoId === "number" ? rawPt.sourceRepoId : void 0,
      sourceKey: typeof rawPt.sourceKey === "string" ? rawPt.sourceKey : void 0,
      sourceSlug: typeof rawPt.sourceSlug === "string" ? rawPt.sourceSlug : void 0
    },
    target
  };
}
async function hMutationResolveTarget(req) {
  const call = makeCall(req);
  const input = req.input;
  const context = input.context ?? {};
  const expected = context.target ?? {};
  const normalized = input.input ?? {};
  const replayOf = input.replayOf && typeof input.replayOf === "object" ? input.replayOf : null;
  const kind = String(input.kind ?? "");
  const directory = typeof context.directory === "string" ? context.directory : "";
  const primaryRemote = typeof context.primaryRemote === "string" ? context.primaryRemote : "origin";
  const repositoryId = typeof context.repositoryId === "string" ? context.repositoryId : "";
  const bindingRevision = typeof context.bindingRevision === "number" ? context.bindingRevision : 0;
  const expectedProj = selectorOf(expected.project);
  const { bb, raw, apiKey, project } = await resolveBoundRepo(
    call,
    { directory, remote: primaryRemote, context },
    expectedProj
  );
  const basePt = {
    ctx: bb.ctx,
    repoId: raw.id,
    key: apiKey,
    slug: raw.slug,
    dtoOwner: project.owner
  };
  if (kind === "change-request-create") {
    const reqRemote = typeof normalized.remote === "string" && normalized.remote ? normalized.remote : primaryRemote;
    if (reqRemote !== primaryRemote) {
      throw new CallError(
        `Pull requests open on the bound remote "${primaryRemote}", not "${reqRemote}".`,
        "SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH",
        409
      );
    }
    const head = typeof expected.head === "string" && expected.head ? expected.head : String(normalized.head ?? "");
    const base = typeof expected.base === "string" && expected.base ? expected.base : String(normalized.base ?? "");
    if (!head || !base) {
      throw new CallError("Creating a pull request requires head and base branches.", "INVALID_SOURCE_CONTROL_MUTATION_CONTEXT", 400);
    }
    let sourceRepo = raw;
    let sourceKey = apiKey;
    const headRemote = typeof normalized.headRemote === "string" && normalized.headRemote ? normalized.headRemote : primaryRemote;
    if (headRemote !== primaryRemote) {
      const headUrl = await readRemoteUrl(directory, headRemote);
      const headParsed = parseRemote(headUrl, call.originUrl);
      const headGot = await fetchRepo(bb, { dtoOwner: headParsed.dtoOwner, repo: headParsed.slug, apiKey: headParsed.projectKey });
      const inNetwork = headGot.repo.id === raw.id || headGot.repo.origin?.id === raw.id;
      if (!inNetwork) {
        throw new CallError(
          `Remote "${headRemote}" is neither "${apiKey}/${raw.slug}" nor a fork of it.`,
          "SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH",
          409
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
        sourceSlug: sourceRepo.slug
      },
      target: {
        repositoryId,
        bindingRevision,
        primaryRemote,
        project: { id: project.id, owner: project.owner, name: project.name },
        head,
        base
      }
    };
  }
  const replayTarget = replayOf?.target && typeof replayOf.target === "object" ? replayOf.target : null;
  const number = (typeof replayTarget?.number === "number" ? replayTarget.number : void 0) ?? (typeof expected.number === "number" ? expected.number : void 0) ?? (typeof normalized.number === "number" ? normalized.number : void 0);
  if (typeof number !== "number" || number < 1) {
    throw new CallError("Target pull request number is required.", "INVALID_SOURCE_CONTROL_MUTATION_CONTEXT", 400);
  }
  if (replayTarget && Object.keys(replayTarget).length > 0) {
    return {
      providerTarget: { ...basePt, number },
      target: replayTarget
    };
  }
  const pr = await fetchPr(bb, apiKey, raw.slug, number);
  const actualHead = pr.fromRef?.displayId ?? "";
  const actualBase = pr.toRef?.displayId ?? "";
  const actualSha = pr.fromRef?.latestCommit ?? "";
  for (const [field, actual] of [
    ["head", actualHead],
    ["base", actualBase],
    ["headSha", actualSha]
  ]) {
    const wanted = typeof expected[field] === "string" ? expected[field] : "";
    if (wanted && wanted.toLowerCase() !== actual.toLowerCase()) {
      throw new CallError(
        `Pull request ${field} changed on Bitbucket.`,
        "SOURCE_CONTROL_MUTATION_TARGET_MISMATCH",
        409
      );
    }
  }
  const resolvedTarget = {
    repositoryId,
    bindingRevision,
    primaryRemote,
    project: { id: project.id, owner: project.owner, name: project.name },
    number,
    head: actualHead,
    base: actualBase
  };
  if (actualSha) resolvedTarget.headSha = actualSha;
  return {
    providerTarget: { ...basePt, number },
    target: resolvedTarget
  };
}
async function hMutationPerform(req) {
  const call = makeCall(req);
  const input = req.input;
  const kind = String(input.kind ?? "");
  const normalized = input.input ?? {};
  const { pt, target } = readProviderTarget(input);
  const bb = new BB(pt.ctx, call.handle, call.forge);
  const repoBase = repoApiPath(bb.ctx, pt.key, pt.slug);
  switch (kind) {
    case "change-request-create": {
      const head = typeof target.head === "string" && target.head ? target.head : String(normalized.head ?? "");
      const base = typeof target.base === "string" && target.base ? target.base : String(normalized.base ?? "");
      if (!head || !base) {
        throw new CallError("Head and base branches are required.", "BAD_REQUEST", 400);
      }
      const targetRepoId = pt.repoId || (await fetchRepo(bb, { dtoOwner: pt.dtoOwner, repo: pt.slug, apiKey: pt.key })).repo.id;
      const sourceRepoId = pt.sourceRepoId ?? targetRepoId;
      const payload = {
        title: String(normalized.title ?? ""),
        draft: normalized.draft === true,
        fromRef: { id: `refs/heads/${head}`, repository: { id: sourceRepoId } },
        toRef: { id: `refs/heads/${base}`, repository: { id: targetRepoId } }
      };
      const bodyText = typeof normalized.body === "string" ? normalized.body : typeof normalized.description === "string" ? normalized.description : void 0;
      if (bodyText !== void 0) payload.description = bodyText;
      const created = await bbPostJson(bb, `${repoBase}/pull-requests`, payload);
      return { number: Number(created.id) };
    }
    case "change-request-update":
    case "change-request-ready":
    case "change-request-draft":
    case "change-request-reviewers": {
      if (!pt.number) throw new CallError("Pull request number is required.", "BAD_REQUEST", 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      const nextTitle = typeof normalized.title === "string" ? normalized.title : pr.title ?? "";
      const hasBody = Object.hasOwn(normalized, "body") || Object.hasOwn(normalized, "description");
      const nextDescription = hasBody ? String(normalized.body ?? normalized.description ?? "") : pr.description ?? "";
      const nextDraft = kind === "change-request-ready" ? false : kind === "change-request-draft" ? true : pr.draft === true;
      const rawNames = Array.isArray(normalized.names) ? normalized.names : Array.isArray(normalized.reviewers) ? normalized.reviewers : null;
      const nextReviewers = kind === "change-request-reviewers" && rawNames ? rawNames.filter((n) => typeof n === "string" && n.trim().length > 0).map((name) => ({ user: { name: name.trim() } })) : (pr.reviewers ?? []).map((r) => r.user?.name).filter((n) => typeof n === "string" && n.length > 0).map((name) => ({ user: { name } }));
      await bbPutJson(bb, `${repoBase}/pull-requests/${pt.number}`, {
        id: pr.id,
        version: pr.version,
        title: nextTitle,
        description: nextDescription,
        draft: nextDraft,
        toRef: pr.toRef,
        reviewers: nextReviewers
      });
      if (kind === "change-request-ready") return { ready: true };
      if (kind === "change-request-draft") return { draft: true };
      return {};
    }
    case "change-request-review": {
      if (!pt.number) throw new CallError("Pull request number is required.", "BAD_REQUEST", 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      const me = call.user?.login ?? "";
      let viewerSlug;
      for (const p of [...pr.reviewers ?? [], ...pr.participants ?? []]) {
        if (p.user && (p.user.name === me || p.user.slug === me)) {
          viewerSlug = p.user.slug ?? p.user.name;
          break;
        }
      }
      if (!viewerSlug && me) {
        const u = await findUserByIdentifier(bb, me);
        viewerSlug = u?.slug ?? u?.name ?? me;
      }
      if (!viewerSlug) throw new CallError("Authenticated user slug could not be determined.", "BAD_REQUEST", 400);
      const verdict = String(normalized.verdict ?? "");
      const headSha = typeof target.headSha === "string" && target.headSha || pr.fromRef?.latestCommit || void 0;
      await bbPutJson(bb, `${repoBase}/pull-requests/${pt.number}/participants/${enc(viewerSlug)}`, {
        status: verdict === "approve" ? "APPROVED" : "NEEDS_WORK",
        ...headSha ? { lastReviewedCommit: headSha } : {}
      });
      let commented = false;
      if (typeof normalized.body === "string" && normalized.body.trim().length > 0) {
        await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/comments`, { text: normalized.body });
        commented = true;
      }
      return { commented };
    }
    case "change-request-merge": {
      if (!pt.number) throw new CallError("Pull request number is required.", "BAD_REQUEST", 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      if (mapPrState(pr) === "merged") return { merged: true };
      const method = String(normalized.method ?? normalized.strategy ?? "merge");
      let strategyId;
      try {
        const settings = await bbGetJson(bb, `${repoBase}/settings/pull-requests`);
        const enabled = (settings.mergeConfig?.strategies ?? []).filter((s) => s.enabled !== false && s.id);
        const prefs = {
          merge: ["no-ff", "ff", "ff-only"],
          squash: ["squash", "squash-ff-only"],
          rebase: ["rebase-no-ff", "rebase-ff-only"]
        };
        for (const candidate of prefs[method] ?? prefs.merge) {
          const hit = enabled.find((s) => (s.id ?? "").toLowerCase() === candidate);
          if (hit?.id) {
            strategyId = hit.id;
            break;
          }
        }
        if (!strategyId && method === "merge" && settings.mergeConfig?.defaultStrategy?.id) {
          strategyId = settings.mergeConfig.defaultStrategy.id;
        }
      } catch (err) {
        if (err instanceof CallError && err.status === 401) throw err;
      }
      const fallbackMap = {
        merge: "no-ff",
        squash: "squash",
        rebase: "rebase-no-ff"
      };
      const merged = await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/merge`, {
        version: pr.version,
        strategyId: strategyId ?? fallbackMap[method] ?? "no-ff"
      });
      return { merged: mapPrState(merged) === "merged" };
    }
    case "change-request-state": {
      if (!pt.number) throw new CallError("Pull request number is required.", "BAD_REQUEST", 400);
      const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
      const want = String(normalized.state ?? "");
      if (want === "closed") {
        await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/decline`, { version: pr.version });
      } else if (want === "open") {
        await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/reopen`, { version: pr.version });
      } else {
        throw new CallError(`Unsupported pull request state "${want}".`, "BAD_REQUEST", 400);
      }
      return { state: want };
    }
    case "change-request-comment": {
      if (!pt.number) throw new CallError("Pull request number is required.", "BAD_REQUEST", 400);
      await bbPostJson(bb, `${repoBase}/pull-requests/${pt.number}/comments`, {
        text: String(normalized.body ?? "")
      });
      return {};
    }
    case "change-request-comment-update": {
      if (!pt.number || typeof normalized.commentId !== "string" || !normalized.commentId) {
        throw new CallError("Pull request number and commentId are required.", "BAD_REQUEST", 400);
      }
      const cPath = `${repoBase}/pull-requests/${pt.number}/comments/${enc(normalized.commentId)}`;
      const existing = await bbGetJson(bb, cPath);
      await bbPutJson(bb, cPath, {
        version: existing.version ?? 0,
        text: String(normalized.body ?? "")
      });
      return {};
    }
    case "change-request-comment-delete": {
      if (!pt.number || typeof normalized.commentId !== "string" || !normalized.commentId) {
        throw new CallError("Pull request number and commentId are required.", "BAD_REQUEST", 400);
      }
      const cPath = `${repoBase}/pull-requests/${pt.number}/comments/${enc(normalized.commentId)}`;
      const existing = await bbGetJson(bb, cPath);
      await bbDelete(bb, cPath, { version: String(existing.version ?? 0) });
      return {};
    }
    default:
      throw new CallError(`Unsupported mutation "${kind}".`, "UNSUPPORTED", 501);
  }
}
var NOT_APPLIED = {
  state: "failed",
  result: { failureStatus: 409, failureCode: "SOURCE_CONTROL_MUTATION_NOT_APPLIED" }
};
async function hMutationReconcile(req) {
  const call = makeCall(req);
  const input = req.input;
  const kind = String(input.kind ?? "");
  const normalized = input.input ?? {};
  const { pt, target } = readProviderTarget(input);
  const bb = new BB(pt.ctx, call.handle, call.forge);
  const repoBase = repoApiPath(bb.ctx, pt.key, pt.slug);
  if (kind === "change-request-create") {
    const head = typeof target.head === "string" ? target.head : "";
    const base = typeof target.base === "string" ? target.base : "";
    if (!head || !base) return { state: "outcome-unknown" };
    const sourceRepoId = pt.sourceRepoId ?? pt.repoId;
    const page = await bbGetJson(bb, `${repoBase}/pull-requests`, {
      at: `refs/heads/${head}`,
      direction: "OUTGOING",
      state: "ALL",
      limit: "50"
    });
    const matches = (Array.isArray(page.values) ? page.values : []).filter(
      (p) => p.fromRef?.displayId === head && p.toRef?.displayId === base && (!sourceRepoId || p.fromRef?.repository?.id === sourceRepoId)
    );
    return matches.length === 1 ? { state: "succeeded", result: { number: Number(matches[0].id) } } : { state: "outcome-unknown" };
  }
  if (!pt.number) return { state: "outcome-unknown" };
  const pr = await fetchPr(bb, pt.key, pt.slug, pt.number);
  switch (kind) {
    case "change-request-merge":
      return mapPrState(pr) === "merged" ? { state: "succeeded", result: { merged: true } } : NOT_APPLIED;
    case "change-request-state": {
      const want = String(normalized.state ?? "");
      const actual = mapPrState(pr);
      return actual === want ? { state: "succeeded", result: { state: actual } } : NOT_APPLIED;
    }
    case "change-request-ready":
      return pr.draft !== true ? { state: "succeeded", result: { ready: true } } : NOT_APPLIED;
    case "change-request-draft":
      return pr.draft === true ? { state: "succeeded", result: { draft: true } } : NOT_APPLIED;
    case "change-request-update": {
      const titleOk = typeof normalized.title !== "string" || pr.title === normalized.title;
      const hasBody = Object.hasOwn(normalized, "body") || Object.hasOwn(normalized, "description");
      const bodyOk = !hasBody || (pr.description ?? "") === String(normalized.body ?? normalized.description ?? "");
      return titleOk && bodyOk ? { state: "succeeded", result: {} } : { state: "outcome-unknown" };
    }
    case "change-request-reviewers": {
      const wanted = (Array.isArray(normalized.names) ? normalized.names : Array.isArray(normalized.reviewers) ? normalized.reviewers : []).filter((n) => typeof n === "string" && n.trim().length > 0).map((n) => n.trim());
      const actual = new Set((pr.reviewers ?? []).map((r) => r.user?.name ?? r.user?.slug ?? "").filter(Boolean));
      const exact = wanted.length === actual.size && wanted.every((w) => actual.has(w));
      return exact ? { state: "succeeded", result: {} } : { state: "outcome-unknown" };
    }
    case "change-request-review": {
      const me = call.user?.login ?? "";
      const wanted = String(normalized.verdict ?? "") === "approve" ? "APPROVED" : "NEEDS_WORK";
      const participant = [...pr.reviewers ?? [], ...pr.participants ?? []].find(
        (p) => p.user && (p.user.name === me || p.user.slug === me)
      );
      if (participant?.status === wanted && !normalized.body) {
        return { state: "succeeded", result: { commented: false } };
      }
      return { state: "outcome-unknown" };
    }
    default:
      return { state: "outcome-unknown" };
  }
}
var store = new ContextPathStore(null);
var forge = null;
function makeCall(req) {
  const session = req.session;
  if (!session) throw new CallError("An active provider session is required.", "BAD_REQUEST", 400);
  let originUrl;
  try {
    originUrl = new URL(session.instance);
  } catch {
    throw new CallError(`Invalid instance URL: ${session.instance}`, "BAD_REQUEST", 400);
  }
  if (!forge) {
    throw new CallError("Outbound forge callback is not configured.", "FORGE_UNREACHABLE", 502);
  }
  return {
    origin: session.instance,
    originUrl,
    handle: session.handle,
    forge,
    ctx: "",
    provider: req.provider,
    identity: { provider: req.provider, instance: session.instance },
    user: session.user
  };
}
var handlers = {
  "auth.verify": hAuthVerify,
  "auth.probe": hAuthProbe,
  "auth.status": hUnsupported,
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
  "mutation.resolveTarget": hMutationResolveTarget,
  "mutation.perform": hMutationPerform,
  "mutation.reconcile": hMutationReconcile
};
function formatError(err) {
  if (err instanceof CallError) {
    const out = {
      message: err.message.slice(0, 2e3),
      code: err.code
    };
    if (typeof err.status === "number" && err.status >= 400 && err.status <= 599) {
      out.status = err.status;
    }
    return out;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { message: `Internal error: ${msg}`.slice(0, 2e3), code: "INTERNAL_ERROR", status: 500 };
}
async function dispatch(body) {
  const req = readSourceControlProviderRequest(body);
  if (!req) {
    return { status: 400, payload: { error: { message: "Invalid source-control wire v1 request." } } };
  }
  try {
    const data = await handlers[req.method](req);
    return { status: 200, payload: { ok: true, data } };
  } catch (err) {
    return { status: 200, payload: { ok: false, error: formatError(err) } };
  }
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
async function startService(opts = {}) {
  const env = opts.env ?? process.env;
  const token = String(env.OPENCHAMBER_SERVICE_TOKEN ?? "");
  const port = Number(env.OPENCHAMBER_SERVICE_PORT ?? 0);
  if (!token) {
    throw new Error("OPENCHAMBER_SERVICE_TOKEN is required");
  }
  const dataDir = String(env.OPENCHAMBER_SERVICE_DATA_DIR ?? "") || null;
  forge = env.OPENCHAMBER_HOST_CALLBACK_URL ? createSourceControlForge({ env }) : null;
  store = new ContextPathStore(dataDir);
  await store.load();
  const expectedAuth = Buffer.from(`Bearer ${token}`, "utf8");
  const server = http.createServer(async (req, res) => {
    const actualAuth = Buffer.from(req.headers.authorization ?? "", "utf8");
    if (actualAuth.length !== expectedAuth.length || !timingSafeEqual(actualAuth, expectedAuth)) {
      sendJson(res, 401, { error: { message: "Unauthorized" } });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === SOURCE_CONTROL_PROVIDER_PATH) {
        const body = await readBody(req, 8e6);
        const out = await dispatch(body);
        sendJson(res, out.status, out.payload);
        return;
      }
      sendJson(res, 404, { error: { message: "Not found" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, msg === "payload_too_large" ? 413 : 500, { error: { message: msg } });
    }
  });
  server.keepAliveTimeout = 5e3;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
  return {
    server,
    port: boundPort,
    dataDir,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}
function isDirectEntry() {
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
    console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
    process.exit(1);
  }
  startService().catch((err) => {
    console.error("openchamber-bitbucket-dc failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
export {
  startService
};
