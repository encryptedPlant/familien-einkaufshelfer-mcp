import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Project rules for agents live in CLAUDE.md; keep `next dev` from
  // generating a separate AGENTS.md.
  agentRules: false,
};

export default nextConfig;
