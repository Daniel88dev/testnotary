import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@testnotary/core", "@testnotary/protocol"],
};

export default nextConfig;
