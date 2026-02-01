import { getActiveAppConnections } from '@/lib/db/app-connections'
import { getPipedreamAccessToken } from './pipedream-auth'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PIPEDREAM_MCP_SERVER_URL = 'https://remote.mcp.pipedream.net'

/**
 * Initialize Pipedream MCP client and get tools for a user.
 *
 * Pipedream MCP: https://remote.mcp.pipedream.net
 * Docs: https://pipedream.com/docs/connect/mcp/developers
 * Tool modes: https://pipedream.com/docs/connect/mcp/tool-modes (we use default sub-agent)
 *
 * - Single server; app specified via x-pd-app-slug. We do not pass x-pd-tool-mode,
 *   so Pipedream uses sub-agent mode: every tool from every app takes a single
 *   "instruction" (natural-language) parameter. Orchestrator enforces this and
 *   normalizes wrong model payloads so tool calls work for 1000+ apps.
 *
 * @param userId - Database user ID (for looking up connections)
 * @param phoneNumber - Phone number to use as externalUserId for Pipedream
 * @returns Object with tools (prefixed with pd_) and cleanup function
 */
export async function initializePipedreamMCP(
  userId: string,
  phoneNumber: string
): Promise<{
  tools: Record<string, any>
  cleanup: () => Promise<void>
}> {
  try {
    // Get user's active app connections from database (using userId)
    const appConnections = await getActiveAppConnections(userId)
    if (appConnections.length === 0) {
      // No connected apps, return empty tools
      return {
        tools: {},
        cleanup: async () => {}
      }
    }

    // Get access token for authentication
    const accessToken = await getPipedreamAccessToken()
    const projectId = process.env.PIPEDREAM_PROJECT_ID
    const environment = process.env.PIPEDREAM_ENVIRONMENT || 'development'

    if (!projectId) {
      throw new Error('PIPEDREAM_PROJECT_ID environment variable is required')
    }

    // Collect all tools from all connected apps
    const allTools: Record<string, any> = {}
    const clients: any[] = []

    // Create MCP client for each connected app
    for (const connection of appConnections) {
      if (!connection.appName) {
        continue
      }

      try {
        const transport = new StreamableHTTPClientTransport(
          new URL(PIPEDREAM_MCP_SERVER_URL),
          {
            requestInit: {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'x-pd-project-id': projectId,
                'x-pd-environment': environment,
                'x-pd-external-user-id': phoneNumber, // Use phone number as externalUserId
                'x-pd-app-slug': connection.appName, // Specify which app's tools we want
              }
            }
          }
        )

        // Create MCP client
        const client = new Client({
          name: 'my-padi',
          version: '1.0.0'
        })

        // Initialize connection with transport
        await client.connect(transport as any)

        // Get tools from this app
        const toolsList = await client.listTools()

        // Prefix tools with pd_ and add to allTools
        // Store app name with tool for later execution
        for (const tool of toolsList.tools) {
          const prefixedName = `pd_${tool.name}`
          allTools[prefixedName] = {
            description: tool.description,
            inputSchema: tool.inputSchema,
            appName: connection.appName // Store app name for execution
          }
        }

        clients.push(client)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        console.error(`[MCP] Error connecting to app ${connection.appName}:`, err.message)
        if (err.stack) console.error('[MCP] stack:', err.stack)
        // Continue with other apps even if one fails
      }
    }

    // Return tools and cleanup function
    return {
      tools: allTools,
      cleanup: async () => {
        // Close all client connections
        for (const client of clients) {
          try {
            await client.close()
          } catch (error) {
            console.error('[MCP] Error closing client:', error)
          }
        }
      }
    }
  } catch (error) {
    console.error('[MCP] Error initializing Pipedream MCP:', error)
    return {
      tools: {},
      cleanup: async () => {}
    }
  }
}
