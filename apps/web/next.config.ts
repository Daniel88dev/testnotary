import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The dev badge sits bottom-left, over the rail's account menu.
  devIndicators: false,
  // `next dev` otherwise writes an AGENTS.md into apps/web on every start.
  agentRules: false,
  transpilePackages: ["@testnotary/core", "@testnotary/protocol"],
  // The docs read their MDX from content/docs; keep it in the standalone output too.
  outputFileTracingIncludes: { "/docs/**": ["./content/docs/**/*"] },
};

export default nextConfig;
