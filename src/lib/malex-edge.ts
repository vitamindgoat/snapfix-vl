import { withMalexAuthQuery } from "./malex-token";

export {
  ensureMalexAccessToken,
  malexAuthHeaders,
  malexToken,
  withMalexAuthQuery,
} from "./malex-token";

function isProbablyLocalDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** Same-origin Edge path; local `next dev` goes through `/malex-edge-proxy`. */
function malexEdgePath(path: string): string {
  if (
    typeof window !== "undefined" &&
    isProbablyLocalDevHost(window.location.hostname)
  ) {
    return `${window.location.origin}/malex-edge-proxy${path}`;
  }
  return path;
}

/** `GET /_malex/instance_status` — JSON snapshot or SSE (`EventSource`). */
export function getMalexInstanceStatusUrl(): string {
  return withMalexAuthQuery(malexEdgePath("/_malex/instance_status"));
}

/**
 * SNAPFIX grounded contractor pipeline (`POST /snapfix/contractors` on Malex Edge).
 */
export function getMalexSnapfixContractorsUrl(): string {
  return malexEdgePath("/snapfix/contractors");
}

/** `POST /_malex/planner/bootstrap` — provision a GPU worker (dashboard uses the same route). */
export function getMalexBootstrapUrl(): string {
  return malexEdgePath("/_malex/planner/bootstrap");
}
