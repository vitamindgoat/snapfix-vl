import type { NextConfig } from "next";

const isProductionBuild = process.env.NODE_ENV === "production";

/** Server-only rewrite target for `next dev` (not baked into the client). */
const malexEdgeOrigin = (
  process.env.MALEX_EDGE_URL?.trim() ||
  process.env.MALEX_EDGE?.trim() ||
  ""
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  ...(isProductionBuild ? { output: "export" as const } : {}),
  async rewrites() {
    if (isProductionBuild || !malexEdgeOrigin) {
      return [];
    }
    return [
      // Local next.dev: proxy Edge paths. Production Pages `_worker.js` serves
      // POST /_malex/ui/session from the Pages secret; Edge has no such route, so
      // the client falls back to JWT refresh / local bootstrap exchange.
      {
        source: "/_malex/:path*",
        destination: `${malexEdgeOrigin}/_malex/:path*`,
      },
      {
        source: "/snapfix/:path*",
        destination: `${malexEdgeOrigin}/snapfix/:path*`,
      },
    ];
  },
};

export default nextConfig;
