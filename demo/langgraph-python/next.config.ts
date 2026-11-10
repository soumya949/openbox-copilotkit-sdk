import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    // The repository root, so Turbopack can resolve the SDK linked from `file:../..`.
    root: path.resolve(process.cwd(), "../.."),
  },
  serverExternalPackages: [
    "@copilotkit/runtime",
    "@openbox-ai/openbox-copilotkit",
    "@openbox-ai/openbox-sdk-ts",
  ],
  env: {
    // The public Threads UI flag is DERIVED from the server-side license token.
    // Set COPILOTKIT_LICENSE_TOKEN (only) to enable Threads — do not set this flag
    // directly. NOTE: NEXT_PUBLIC_* resolves at BUILD time while the runtime reads
    // the token per-request, so the UI gate and runtime agree only when the token is
    // present at build time (the standard `next dev` / host-build flow). For a
    // standalone/Docker image built without the token and injected at runtime, set
    // COPILOTKIT_LICENSE_TOKEN at build time too (or gate the UI at runtime) so the
    // baked flag reflects it.
    NEXT_PUBLIC_COPILOTKIT_THREADS_ENABLED: process.env.COPILOTKIT_LICENSE_TOKEN
      ? "true"
      : "false",
  },
  typescript: {
    // HttpAgent currently has a type mismatch with CopilotRuntime.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
