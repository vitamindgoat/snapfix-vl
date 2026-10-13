"use client";

import { useEffect, useState } from "react";
import {
  ensureMalexAccessToken,
  malexAuthHeaders,
  withMalexAuthQuery,
} from "@/lib/malex";

export type VastStatus =
  | "init"
  | "active"
  | "ready"
  | "hibernated"
  | "error"
  | "terminated";

export type DisplayStatus = VastStatus | "unknown";

export type InstanceStatusConnection = "connecting" | "live" | "reconnecting";

export interface InstanceRow {
  instance_id: string;
  worker_id?: string;
  status: VastStatus;
  update_time?: string;
  last_activity?: string;
}

const VALID_STATUS = new Set<string>([
  "init",
  "active",
  "ready",
  "hibernated",
  "error",
  "terminated",
]);

function parseInstanceRow(item: unknown): InstanceRow | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const o = item as Record<string, unknown>;
  if (typeof o.instance_id !== "string") {
    return null;
  }
  if (typeof o.status !== "string" || !VALID_STATUS.has(o.status)) {
    return null;
  }
  return {
    instance_id: o.instance_id,
    worker_id: typeof o.worker_id === "string" ? o.worker_id : undefined,
    status: o.status as VastStatus,
    update_time: typeof o.update_time === "string" ? o.update_time : undefined,
    last_activity: typeof o.last_activity === "string" ? o.last_activity : undefined,
  };
}

const STATUS_PRIORITY: Record<VastStatus, number> = {
  ready: 0,
  active: 1,
  init: 2,
  hibernated: 3,
  error: 4,
  terminated: 5,
};

function updateTimeMs(row: InstanceRow): number {
  const t = row.update_time?.trim();
  if (!t) return 0;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Edge returns historical rows; pick the newest live-ish instance for the status pill. */
function pickPrimaryInstance(raw: unknown): InstanceRow | null {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const rows = items
    .map(parseInstanceRow)
    .filter((row): row is InstanceRow => row !== null);
  if (rows.length === 0) {
    return null;
  }
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    return updateTimeMs(b) - updateTimeMs(a);
  })[0];
}

export function useMalexInstanceStatus(): {
  displayStatus: DisplayStatus;
  instanceId: string | undefined;
  connection: InstanceStatusConnection;
  bootstrapComplete: boolean;
  lastError: string | null;
} {
  const [row, setRow] = useState<InstanceRow | null>(null);
  const [bootstrapComplete, setBootstrapComplete] = useState(false);
  const [connection, setConnection] = useState<InstanceStatusConnection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    void (async () => {
      await ensureMalexAccessToken();
      const url = withMalexAuthQuery("/_malex/instance_status");

      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json", ...malexAuthHeaders() },
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`instance_status: HTTP ${res.status}`);
        }
        const data: unknown = await res.json();
        if (!cancelled) {
          const parsed = pickPrimaryInstance(data);
          setRow(parsed);
          setLastError(null);
        }
      } catch (e) {
        if (!cancelled) {
          const base = e instanceof Error ? e.message : "Initial fetch failed";
          const hint =
            " Ensure Malex Edge is reachable on this origin for GET /_malex/instance_status (set MALEX_EDGE_URL for next dev rewrites).";
          setLastError(
            base === "Failed to fetch" || base.includes("NetworkError")
              ? `${base}.${hint}`
              : base,
          );
          setRow(null);
        }
      } finally {
        if (!cancelled) {
          setBootstrapComplete(true);
        }
      }

      if (cancelled) {
        return;
      }

      const stream = new EventSource(url);
      if (cancelled) {
        stream.close();
        return;
      }
      es = stream;

      const applyPayload = (raw: string) => {
        try {
          const data = JSON.parse(raw) as unknown;
          const parsed = pickPrimaryInstance(data);
          setRow(parsed);
          setLastError(null);
        } catch (e) {
          setLastError(e instanceof Error ? e.message : "Invalid JSON");
          /* Keep last known row on transient parse errors. */
        }
      };

      stream.addEventListener("open", () => {
        setConnection("live");
        setLastError(null);
      });
      stream.addEventListener("snapshot", (ev: MessageEvent) =>
        applyPayload(String(ev.data)),
      );
      stream.addEventListener("update", (ev: MessageEvent) =>
        applyPayload(String(ev.data)),
      );
      stream.addEventListener("error", () => {
        setConnection("reconnecting");
      });
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  const displayStatus: DisplayStatus =
    row === null ? "unknown" : row.status;

  return {
    displayStatus,
    instanceId: row?.instance_id,
    connection,
    bootstrapComplete,
    lastError,
  };
}
