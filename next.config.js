/** @type {import('next').NextConfig} */
const path = require('path')

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['@modelcontextprotocol/sdk'],
  },
  webpack: (config, { isServer }) => {
    // Force webpack to resolve @modelcontextprotocol/sdk from node_modules (fixes "Module not found" on Vercel).
    const sdkRoot = path.resolve(__dirname, 'node_modules/@modelcontextprotocol/sdk')
    config.resolve.alias = {
      ...config.resolve.alias,
      '@modelcontextprotocol/sdk': sdkRoot,
      // Subpath: package exports "./*" -> dist/cjs/* for require (Node server)
      '@modelcontextprotocol/sdk/client/streamableHttp.js': path.resolve(sdkRoot, 'dist/cjs/client/streamableHttp.js'),
    }
    return config
  },
}

module.exports = nextConfig

