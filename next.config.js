/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['@modelcontextprotocol/sdk'],
  },
}

module.exports = nextConfig

