"use client";

import {
  useMalexInstanceStatus,
  type DisplayStatus,
} from "@/hooks/useMalexInstanceStatus";

function isGpuLoading(status: DisplayStatus, bootstrapComplete: boolean): boolean {
  if (status === "init") {
    return true;
  }
  if (!bootstrapComplete) {
    return true;
  }
  return false;
}

export function GpuLoadingBanner() {
  const { displayStatus, bootstrapComplete, instanceId, lastError } =
    useMalexInstanceStatus();

  if (!isGpuLoading(displayStatus, bootstrapComplete)) {
    return null;
  }

  const title =
    displayStatus === "init" || instanceId
      ? "GPU is loading"
      : "Connecting to Malex Edge";

  const detail =
    displayStatus === "init"
      ? "Your worker is starting on Vast.ai. You can use the form below once status shows Ready or Active."
      : bootstrapComplete
        ? "Checking instance status…"
        : "Fetching GPU status from Malex Edge…";

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
      role="status"
      aria-live="polite"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-amber-900/90">{detail}</p>
      {instanceId && (
        <p className="mt-1 font-mono text-xs text-amber-800/80">
          instance {instanceId}
        </p>
      )}
      {lastError && (
        <p className="mt-2 text-xs text-red-800 whitespace-pre-wrap">{lastError}</p>
      )}
    </div>
  );
}
