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
      {
        source: "/malex-edge-proxy/_malex/:path*",
        destination: `${malexEdgeOrigin}/_malex/:path*`,
      },
      {
        source: "/malex-edge-proxy/snapfix/:path*",
        destination: `${malexEdgeOrigin}/snapfix/:path*`,
      },
    ];
  },
};

export default nextConfig;
