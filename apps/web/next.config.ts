import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The dev badge sits bottom-left, over the rail's account menu.
  devIndicators: false,
  transpilePackages: ["@testnotary/core", "@testnotary/protocol"],
};

export default nextConfig;
