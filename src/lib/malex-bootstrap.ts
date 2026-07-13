import { getMalexBootstrapUrl } from "@/lib/malex-edge";
import { ensureMalexAccessToken, malexAuthHeaders } from "@/lib/malex-token";

/** Default SNAPFIX GPU bootstrap payload (matches dashboard deploy defaults). */
const SNAPFIX_BOOTSTRAP_BASE = {
  pod_count: 1,
  malex_email: "alex@rybitskyi.com",
  project_name: "snapfix",
  gpu_name: "l40s",
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
};

function envDeployMeta(): DeployMeta {
  const meta: DeployMeta = {};
  const uri = process.env.NEXT_PUBLIC_MALEX_PROJECT_R2_URI?.trim();
  const bins = process.env.NEXT_PUBLIC_MALEX_BINS_R2_PREFIX?.trim();
  const script = process.env.NEXT_PUBLIC_MALEX_WEB_SCRIPT?.trim();
  if (uri) meta.project_r2_uri = uri;
  if (bins) meta.bins_r2_prefix = bins;
  if (script) meta.web_script = script;
  return meta;
}

async function loadDeployMeta(): Promise<DeployMeta> {
  const fromEnv = envDeployMeta();
  if (fromEnv.project_r2_uri) {
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
  return body;
}

export type BootstrapResult =
  | { ok: true; instanceIds: string[] }
  | { ok: false; message: string };

export async function bootstrapMalexGpu(): Promise<BootstrapResult> {
  await ensureMalexAccessToken();
  const meta = await loadDeployMeta();
  const res = await fetch(getMalexBootstrapUrl(), {
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
