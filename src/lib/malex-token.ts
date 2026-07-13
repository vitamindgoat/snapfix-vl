function isProbablyLocalDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** Query param accepted by Malex Edge when headers are unavailable (SSE). */
export const MALEX_API_KEY_QUERY_PARAM = "api_key";

const DASHBOARD_AUTH_KEY = "malex_dashboard_auth_token";
const REFRESH_LEEWAY_SECS = 300;

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let cache: TokenCache | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<string | undefined> | null = null;

function bootstrapFromEnv(): string | undefined {
  const raw =
    process.env.NEXT_PUBLIC_MALEX_TOKEN?.trim() ||
    process.env.NEXT_PUBLIC_MALEX_API_KEY?.trim();
  return raw || undefined;
}

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
    jwtExpUnix(token) ??
    Math.floor(Date.now() / 1000) + (expiresIn ?? 7200);
  cache = { accessToken: token, expiresAt: exp };
}

function tokenUrl(): string {
  if (
    typeof window !== "undefined" &&
    isProbablyLocalDevHost(window.location.hostname)
  ) {
    return `${window.location.origin}/malex-edge-proxy/_malex/auth/token`;
  }
  return "/_malex/auth/token";
}

function loginTokenFromStorage(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const t = window.localStorage.getItem(DASHBOARD_AUTH_KEY)?.trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

async function exchangeBootstrap(bootstrap: string): Promise<string | undefined> {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrap}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ kind: "client", sub: "client:bootstrap" }),
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
 * Resolve a short-lived Edge JWT (login token, cached JWT, or bootstrap exchange).
 */
export async function ensureMalexAccessToken(): Promise<string | undefined> {
  if (cache && !needsRefresh(cache.expiresAt)) {
    return cache.accessToken;
  }

  const stored = loginTokenFromStorage();
  if (stored) {
    if (isProbablyJwt(stored)) {
      const exp = jwtExpUnix(stored);
      if (exp && !needsRefresh(exp)) {
        setCache(stored, exp - Math.floor(Date.now() / 1000));
        scheduleRefresh();
        return stored;
      }
    }
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    const bootstrap = bootstrapFromEnv();
    if (bootstrap) {
      if (isProbablyJwt(bootstrap)) {
        const exp = jwtExpUnix(bootstrap);
        if (exp && !needsRefresh(exp)) {
          setCache(bootstrap);
          scheduleRefresh();
          return bootstrap;
        }
      } else {
        const exchanged = await exchangeBootstrap(bootstrap);
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

/** Cached access token (call `ensureMalexAccessToken` first in the browser). */
export function malexToken(): string | undefined {
  if (cache?.accessToken) return cache.accessToken;
  const bootstrap = bootstrapFromEnv();
  if (bootstrap && !isProbablyJwt(bootstrap)) return undefined;
  return bootstrap ?? loginTokenFromStorage();
}

/** Headers for authenticated Edge requests (all routes except `GET /_malex/health`). */
export function malexAuthHeaders(): Record<string, string> {
  const token = malexToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/** Append `api_key` for browser `EventSource` (cannot set custom headers). */
export async function withMalexAuthQueryAsync(url: string): Promise<string> {
  await ensureMalexAccessToken();
  return withMalexAuthQuery(url);
}

export function withMalexAuthQuery(url: string): string {
  const token = malexToken();
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${MALEX_API_KEY_QUERY_PARAM}=${encodeURIComponent(token)}`;
}
