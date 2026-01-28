import { createBackendClient, type BackendClient } from '@pipedream/sdk'

/**
 * Get Pipedream client for authentication
 * This client is used to get access tokens for MCP server requests
 */
export function getPipedreamClient(): BackendClient {
  const clientId = process.env.PIPEDREAM_CLIENT_ID
  const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET
  const projectId = process.env.PIPEDREAM_PROJECT_ID
  const environment = process.env.PIPEDREAM_ENVIRONMENT || 'development'

  if (!clientId || !clientSecret || !projectId) {
    throw new Error(
      'Missing Pipedream credentials. Please set PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, and PIPEDREAM_PROJECT_ID environment variables.'
    )
  }

  return createBackendClient({
    environment: environment as 'development' | 'production',
    projectId,
    credentials: {
      clientId,
      clientSecret,
    },
  })
}

/**
 * Get access token for MCP server authentication
 * This token is used in Authorization header for all MCP requests
 */
export async function getPipedreamAccessToken(): Promise<string> {
  const client = getPipedreamClient()
  const token = await client.rawAccessToken()
  return typeof token === 'string' ? token : await token
}
