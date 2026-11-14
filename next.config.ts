import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Setting packs and every pack's demo data are read with fs at runtime: ship them with every
  // function. All of data/ is included, so a new pack's demo folder needs no change here.
  outputFileTracingIncludes: {
    "/*": ["./packs/**/*", "./data/**/*"],
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
