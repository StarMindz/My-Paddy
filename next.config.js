/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@modelcontextprotocol/sdk', '@ai-sdk/mcp'],
  experimental: {
    esmExternals: 'loose',
  },
}

module.exports = nextConfig

