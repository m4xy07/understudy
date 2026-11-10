import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The setting pack and the demo exports are read with fs at runtime: ship them with every function.
  outputFileTracingIncludes: {
    "/*": ["./packs/**/*", "./data/demo/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
