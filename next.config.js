/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next.js 14: opt out of bundling so Route Handlers use Node require() instead of webpack resolving the package.
  // https://nextjs.org/docs/14/app/api-reference/next-config-js/serverComponentsExternalPackages
  experimental: {
    serverComponentsExternalPackages: ['@modelcontextprotocol/sdk'],
  },
}

module.exports = nextConfig

