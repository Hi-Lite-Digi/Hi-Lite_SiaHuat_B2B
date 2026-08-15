import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "store.siahuat.com",
        pathname: "/image-proxy/**",
      },
    ],
  },
};

export default nextConfig;
