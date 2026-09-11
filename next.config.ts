import type { NextConfig } from "next";
import packageJson from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@prisma/client", "prisma"],
  env: {
    APP_VERSION: packageJson.version,
  },
};

export default nextConfig;
