import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'standalone',
  basePath: '/dashboard',
  // The dashboard is an npm workspace: its dependencies are installed from the
  // repository root's lockfile, above this directory. Next leaves out of the
  // standalone output every file outside this root, so the root has to be the
  // repository root. The output then mirrors the repository layout, and
  // server.js lands at packages/web-dashboard/server.js inside it.
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

export default nextConfig;
