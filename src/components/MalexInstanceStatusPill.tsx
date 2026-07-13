"use client";

import { useState } from "react";
import {
  useMalexInstanceStatus,
  type DisplayStatus,
} from "@/hooks/useMalexInstanceStatus";
import { bootstrapMalexGpu } from "@/lib/malex-bootstrap";

/** Keep "Starting…" visible while instance_status SSE catches up after bootstrap. */
const BOOTSTRAP_STATUS_DELAY_MS = 5000;

function labelForStatus(
  displayStatus: DisplayStatus,
  bootstrapComplete: boolean,
): string {
  if (!bootstrapComplete) {
    return "Connecting…";
  }
  switch (displayStatus) {
    case "active":
      return "Active";
    case "ready":
      return "Ready";
    case "init":
      return "Initializing";
    case "hibernated":
      return "Hibernated";
    case "error":
      return "Error";
    case "terminated":
      return "Terminated";
    case "unknown":
    default:
      return "No instance";
  }
}

function pillAppearance(
  displayStatus: DisplayStatus,
  bootstrapComplete: boolean,
): { shell: string; dot: string; dotPulse: boolean } {
  if (!bootstrapComplete) {
    return {
      shell: "border-zinc-300 bg-zinc-50 text-zinc-600 opacity-90",
      dot: "bg-zinc-400",
      dotPulse: true,
    };
  }
  switch (displayStatus) {
    case "active":
    case "ready":
      return {
        shell: "border-green-200 bg-green-50 text-green-900",
        dot: "bg-green-500",
        dotPulse: false,
      };
    case "init":
      return {
        shell: "border-amber-200 bg-amber-50 text-amber-900",
        dot: "bg-yellow-400",
        dotPulse: true,
      };
    case "hibernated":
      return {
        shell: "border-sky-200 bg-sky-50 text-sky-900",
        dot: "bg-sky-400",
        dotPulse: false,
      };
    case "error":
      return {
        shell: "border-red-200 bg-red-50 text-red-900",
        dot: "bg-red-500",
        dotPulse: false,
      };
    case "terminated":
      return {
        shell: "border-zinc-300 bg-zinc-100 text-zinc-700",
        dot: "bg-zinc-400",
        dotPulse: false,
      };
    case "unknown":
    default:
      return {
        shell: "border-zinc-300 bg-zinc-100 text-zinc-700",
        dot: "bg-zinc-400",
        dotPulse: false,
      };
  }
}

export function MalexInstanceStatusPill() {
  const {
    displayStatus,
    instanceId,
    connection,
    bootstrapComplete,
    lastError,
  } = useMalexInstanceStatus();

  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const { shell, dot, dotPulse } = pillAppearance(displayStatus, bootstrapComplete);
  const label = labelForStatus(displayStatus, bootstrapComplete);
  const showRun =
    bootstrapComplete &&
    (displayStatus === "terminated" || displayStatus === "unknown") &&
    !bootstrapping;

  const titleParts: string[] = [
    `Malex GPU instance: ${label}`,
    instanceId ? `instance_id=${instanceId}` : null,
    connection === "reconnecting" ? "Stream reconnecting…" : null,
    bootstrapError ?? lastError ?? null,
  ].filter(Boolean) as string[];
  const title = titleParts.join(" · ");

  const ariaLabel =
    instanceId !== undefined ? `${label}, instance ${instanceId}` : label;

  const handleRun = async () => {
    setBootstrapping(true);
    setBootstrapError(null);
    const startedAt = Date.now();
    try {
      const result = await bootstrapMalexGpu();
      if (!result.ok) {
        setBootstrapError(result.message);
      }
    } catch (e) {
      setBootstrapError(
        e instanceof Error ? e.message : "Bootstrap request failed",
      );
    } finally {
      const remaining = BOOTSTRAP_STATUS_DELAY_MS - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      setBootstrapping(false);
    }
  };

  return (
    <div className="flex items-center gap-2 shrink-0">
      <span
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${shell} ${
          connection === "reconnecting" && bootstrapComplete
            ? "ring-2 ring-amber-200 ring-offset-1"
            : ""
        }`}
        title={title}
        aria-label={ariaLabel}
      >
        <span
          className={`inline-block size-2.5 shrink-0 rounded-full ${dot} ${
            dotPulse ? "animate-pulse" : ""
          }`}
          aria-hidden
        />
        <span>{bootstrapping ? "Starting…" : label}</span>
      </span>
      {showRun && (
        <button
          type="button"
          onClick={() => void handleRun()}
          className="rounded-md border border-blue-600 bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
          title="Provision a new Malex GPU worker"
        >
          Run
        </button>
      )}
      {bootstrapping && (
        <span className="text-xs text-zinc-500" aria-live="polite">
          Provisioning…
        </span>
      )}
    </div>
  );
}
