/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // So Next.js can resolve and bundle @modelcontextprotocol/sdk (ESM package used in API routes)
  transpilePackages: ['@modelcontextprotocol/sdk'],
}

module.exports = nextConfig

