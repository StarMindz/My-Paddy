/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@modelcontextprotocol/sdk', '@ai-sdk/mcp'],
}

module.exports = nextConfig

