const path = require("path");
const isStandaloneOutput = process.env.NEXT_OUTPUT_STANDALONE === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isStandaloneOutput ? { output: "standalone" } : {}),
  transpilePackages: [
    "@provacx/api",
    "@provacx/database",
    "@provacx/shared",
    "@provacx/ui",
    "@provacx/drawing-engine",
    "@provacx/boq-engine",
    "@provacx/document-editor",
  ],
  experimental: {
    outputFileTracingRoot: path.join(__dirname, "../../"),
    // Explicitly include Prisma engine files when tracing app routes.
    outputFileTracingIncludes: {
      "/api/**/*": ["./node_modules/.prisma/**/*"],
      "/dashboard/**/*": ["./node_modules/.prisma/**/*"],
      "/login": ["./node_modules/.prisma/**/*"],
      "/register": ["./node_modules/.prisma/**/*"],
      "/onboarding/**/*": ["./node_modules/.prisma/**/*"],
      "/projects/**/*": ["./node_modules/.prisma/**/*"],
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        canvas: false,
      };
    } else {
      config.externals = [...(config.externals || []), { canvas: "canvas" }];
    }
    return config;
  },
};

module.exports = nextConfig;
