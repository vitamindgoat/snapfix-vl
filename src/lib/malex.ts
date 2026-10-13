/** Query param accepted by Malex Edge when headers are unavailable (SSE). */
const MALEX_API_KEY_QUERY_PARAM = "api_key";

/** Login JWT from Track B (`POST /_malex/auth/login`). */
export const MALEX_UI_AUTH_TOKEN_KEY = "malex_tenant_auth_token";

const REFRESH_LEEWAY_SECS = 300;

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let cache: TokenCache | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<string | undefined> | null = null;

function jwtExpUnix(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function isProbablyJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function needsRefresh(expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return expiresAt === 0 || now + REFRESH_LEEWAY_SECS >= expiresAt;
}

function setCache(token: string, expiresIn?: number) {
  const exp =
    jwtExpUnix(token) ?? Math.floor(Date.now() / 1000) + (expiresIn ?? 7200);
  cache = { accessToken: token, expiresAt: exp };
}

function jwtClaims(token: string): { sub?: string; kind?: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sub?: string; kind?: string };
  } catch {
    return null;
  }
}

/** Optional baked JWT (Track A / local). Never put long-lived bootstrap in `NEXT_PUBLIC_*` for prod. */
function tokenFromEnv(): string | undefined {
  const raw =
    process.env.NEXT_PUBLIC_MALEX_TOKEN?.trim() ||
    process.env.NEXT_PUBLIC_MALEX_API_KEY?.trim();
  return raw || undefined;
}

export function getLoginAccessToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const t = window.localStorage.getItem(MALEX_UI_AUTH_TOKEN_KEY)?.trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export function setLoginAccessToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MALEX_UI_AUTH_TOKEN_KEY, token.trim());
  } catch {
    /* quota / private mode */
  }
  setCache(token.trim());
}

export function clearLoginAccessToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MALEX_UI_AUTH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
  cache = null;
}

async function exchangeCredential(credential: string): Promise<string | undefined> {
  const claims = isProbablyJwt(credential) ? jwtClaims(credential) : null;
  const res = await fetch("/_malex/auth/token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      kind: claims?.kind ?? "client",
      sub: claims?.sub ?? "client:bootstrap",
    }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  const token = data.access_token?.trim();
  if (!token) return undefined;
  setCache(token, data.expires_in);
  return token;
}

/** Track C: Pages `_worker.js` (or next.dev middleware) mints JWT via Pages/local secret. */
async function mintViaUiSession(): Promise<string | undefined> {
  const res = await fetch("/_malex/ui/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  const token = data.access_token?.trim();
  if (!token) return undefined;
  setCache(token, data.expires_in);
  return token;
}

function scheduleRefresh() {
  if (typeof window === "undefined" || refreshTimer) return;
  refreshTimer = setInterval(
    () => {
      void ensureMalexAccessToken();
    },
    50 * 60 * 1000,
  );
}

/**
 * Resolve a short-lived Edge JWT.
 * Priority: login session → cache → POST /_malex/ui/session → env JWT refresh → local bootstrap exchange.
 */
export async function ensureMalexAccessToken(): Promise<string | undefined> {
  if (cache && !needsRefresh(cache.expiresAt)) {
    return cache.accessToken;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    const login = getLoginAccessToken();
    if (login && isProbablyJwt(login)) {
      const exp = jwtExpUnix(login);
      if (exp && !needsRefresh(exp)) {
        setCache(login);
        scheduleRefresh();
        return login;
      }
      const refreshed = await exchangeCredential(login);
      if (refreshed) {
        setLoginAccessToken(refreshed);
        scheduleRefresh();
        return refreshed;
      }
    }

    const fromSession = await mintViaUiSession();
    if (fromSession) {
      scheduleRefresh();
      return fromSession;
    }

    const fromEnv = tokenFromEnv();
    if (fromEnv) {
      if (isProbablyJwt(fromEnv)) {
        const exp = jwtExpUnix(fromEnv);
        if (exp && !needsRefresh(exp)) {
          setCache(fromEnv);
          scheduleRefresh();
          return fromEnv;
        }
        const refreshed = await exchangeCredential(fromEnv);
        if (refreshed) {
          scheduleRefresh();
          return refreshed;
        }
      } else {
        const exchanged = await exchangeCredential(fromEnv);
        if (exchanged) {
          scheduleRefresh();
          return exchanged;
        }
      }
    }

    return undefined;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

function malexToken(): string | undefined {
  if (cache?.accessToken) return cache.accessToken;
  const login = getLoginAccessToken();
  if (login && isProbablyJwt(login)) return login;
  const fromEnv = tokenFromEnv();
  if (fromEnv && isProbablyJwt(fromEnv)) return fromEnv;
  return undefined;
}

/** Headers for authenticated Edge requests. */
export function malexAuthHeaders(): Record<string, string> {
  const token = malexToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/** Append `api_key` for browser `EventSource` (cannot set custom headers). */
export function withMalexAuthQuery(url: string): string {
  const token = malexToken();
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${MALEX_API_KEY_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; message: string };

/** Track B: email/password → JWT via `POST /_malex/auth/login`. */
export async function loginMalexTenant(
  email: string,
  password: string,
): Promise<LoginResult> {
  const res = await fetch("/_malex/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return {
      ok: false,
      message: `Login failed (HTTP ${res.status})`,
    };
  }
  const o =
    data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const token =
    (typeof o?.token === "string" && o.token.trim()) ||
    (typeof o?.access_token === "string" && o.access_token.trim()) ||
    "";
  const error =
    typeof o?.error === "string" && o.error.trim()
      ? o.error.trim()
      : typeof o?.msg === "string" && o.msg.trim()
        ? o.msg.trim()
        : null;

  if (!res.ok || o?.success === false || !token) {
    return {
      ok: false,
      message: error ?? `Login failed (HTTP ${res.status})`,
    };
  }
  setLoginAccessToken(token);
  scheduleRefresh();
  return { ok: true };
}

/** Shared bootstrap fields; GPU type comes from deploy metadata (`malexai run`). */
const SNAPFIX_BOOTSTRAP_BASE = {
  pod_count: 1,
  malex_email: "alex.rybitskyi1@gmail.com",
  project_name: "snapfix",
  num_gpus: 1,
  limit: 20,
  disk: 16,
  disk_space_min_gb: 16,
  dph_max: 2.5,
  cuda_vers_min: 12,
  gpu_ram_min_gb: 39,
  inet_down_min: 1000,
} as const;

type DeployMeta = {
  project_name?: string;
  project_r2_uri?: string;
  bins_r2_prefix?: string;
  web_script?: string;
  /** Canonical GPU id from resolved `[tool.malex] instance-type`. */
  gpu_name?: string;
};

function envDeployMeta(): DeployMeta {
  const meta: DeployMeta = {};
  const uri = process.env.NEXT_PUBLIC_MALEX_PROJECT_R2_URI?.trim();
  const bins = process.env.NEXT_PUBLIC_MALEX_BINS_R2_PREFIX?.trim();
  const script = process.env.NEXT_PUBLIC_MALEX_WEB_SCRIPT?.trim();
  const gpu = process.env.NEXT_PUBLIC_MALEX_GPU_NAME?.trim();
  if (uri) meta.project_r2_uri = uri;
  if (bins) meta.bins_r2_prefix = bins;
  if (script) meta.web_script = script;
  if (gpu) meta.gpu_name = gpu;
  return meta;
}

async function loadDeployMeta(): Promise<DeployMeta> {
  const fromEnv = envDeployMeta();
  if (fromEnv.project_r2_uri && fromEnv.gpu_name) {
    return fromEnv;
  }
  try {
    const res = await fetch("/malex-deploy.json", { cache: "no-store" });
    if (!res.ok) return fromEnv;
    const data = (await res.json()) as DeployMeta;
    return { ...fromEnv, ...data };
  } catch {
    return fromEnv;
  }
}

function snapfixBootstrapBody(meta: DeployMeta): Record<string, unknown> {
  const body: Record<string, unknown> = { ...SNAPFIX_BOOTSTRAP_BASE };
  if (meta.project_name?.trim()) {
    body.project_name = meta.project_name.trim();
  }
  if (meta.project_r2_uri?.trim()) {
    body.project_r2_uri = meta.project_r2_uri.trim();
  }
  if (meta.bins_r2_prefix?.trim()) {
    body.bins_r2_prefix = meta.bins_r2_prefix.trim();
  }
  if (meta.web_script?.trim()) {
    body.web_script = meta.web_script.trim();
  }
  if (meta.gpu_name?.trim()) {
    body.gpu_name = meta.gpu_name.trim();
  }
  return body;
}

export type BootstrapResult =
  | { ok: true; instanceIds: string[] }
  | { ok: false; message: string };

export async function bootstrapMalexGpu(): Promise<BootstrapResult> {
  await ensureMalexAccessToken();
  const meta = await loadDeployMeta();
  const res = await fetch("/_malex/planner/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...malexAuthHeaders() },
    body: JSON.stringify(snapfixBootstrapBody(meta)),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: `Bootstrap failed (${res.status})${text ? `: ${text}` : ""}`,
    };
  }

  const o =
    data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const success = o?.success === true;
  const instanceIds = Array.isArray(o?.instance_ids)
    ? o.instance_ids.filter((id): id is string => typeof id === "string")
    : [];
  const error =
    typeof o?.error === "string" && o.error.trim()
      ? o.error.trim()
      : typeof o?.msg === "string" && o.msg.trim()
        ? o.msg.trim()
        : null;

  if (!res.ok) {
    return {
      ok: false,
      message: error ?? `Bootstrap failed (HTTP ${res.status})`,
    };
  }

  if (!success || instanceIds.length === 0) {
    return {
      ok: false,
      message:
        error ??
        `Bootstrap failed (${JSON.stringify(data)}). Redeploy malex-edge if the response has no "error" field.`,
    };
  }

  return { ok: true, instanceIds };
}
