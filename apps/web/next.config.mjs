/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The browser talks to the API directly (see lib/api.ts). Keeping the two
  // services decoupled mirrors how an operator console would call a separate
  // control-plane API in production.
};

export default nextConfig;
