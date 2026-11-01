import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@react-pdf/renderer"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;