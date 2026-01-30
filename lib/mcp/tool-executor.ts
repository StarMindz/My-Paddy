import { getAppConnection } from '@/lib/db/app-connections'
import { getPipedreamAccessToken } from './pipedream-auth'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PIPEDREAM_MCP_SERVER_URL = 'https://remote.mcp.pipedream.net'

/**
 * Execute a Pipedream MCP tool.
 *
 * Pipedream docs: https://pipedream.com/docs/connect/mcp/developers
 * Tool modes: https://pipedream.com/docs/connect/mcp/tool-modes
 *
 * We use sub-agent mode (default): MCP tools/call expects params.arguments to be
 * an object. For sub-agent, Pipedream expects { instruction: "..." }. The
 * orchestrator normalizes model output to that shape before calling this.
 * Tool name passed to callTool must match exactly what listTools returned (we strip pd_ prefix).
 *
 * @param userId - Database user ID (for looking up connections)
 * @param phoneNumber - Phone number to use as externalUserId for Pipedream
 * @param toolName - Tool name (with pd_ prefix, e.g. pd_create_calendar_event)
 * @param args - Tool arguments (for sub-agent: { instruction: "..." })
 * @param appName - App slug (e.g. google_calendar), stored with tool definition
 * @returns Tool execution result
 */
export async function executePipedreamTool(
  userId: string,
  phoneNumber: string,
  toolName: string,
  args: Record<string, any>,
  appName?: string
): Promise<{ result: any; error?: string }> {
  try {
    // Remove pd_ prefix to get actual tool name
    const actualToolName = toolName.startsWith('pd_') ? toolName.slice(3) : toolName

    // If appName not provided, try to extract from tool name
    // This is a fallback - ideally appName should be stored with tool definition
    let resolvedAppName = appName

    if (!resolvedAppName) {
      // Heuristic: try to extract app name from tool name
      // Pipedream tools are typically: app_action (e.g., "google_calendar_create_event")
      const parts = actualToolName.split('_')
      if (parts.length >= 2) {
        // Try first part (e.g., "google") or first two parts (e.g., "google_calendar")
        const possibleAppNames = [parts[0], `${parts[0]}_${parts[1]}`]
        
        for (const possibleApp of possibleAppNames) {
          const connection = await getAppConnection(userId, possibleApp)
          if (connection && connection.active) {
            resolvedAppName = possibleApp
            break
          }
        }
      }
    }

    if (!resolvedAppName) {
      return {
        result: null,
        error: `Could not determine app for tool: ${toolName}. Please ensure the app is connected.`
      }
    }

    // Verify connection exists and is active
    const connection = await getAppConnection(userId, resolvedAppName)
    if (!connection || !connection.active) {
      return {
        result: null,
        error: `No active connection found for app: ${resolvedAppName}. Please connect the app first.`
      }
    }

    // Get access token for authentication
    const accessToken = await getPipedreamAccessToken()
    const projectId = process.env.PIPEDREAM_PROJECT_ID
    const environment = process.env.PIPEDREAM_ENVIRONMENT || 'development'

    if (!projectId) {
      return {
        result: null,
        error: 'PIPEDREAM_PROJECT_ID environment variable is required'
      }
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(PIPEDREAM_MCP_SERVER_URL),
      {
        requestInit: {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-pd-project-id': projectId,
            'x-pd-environment': environment,
            'x-pd-external-user-id': phoneNumber, // Use phone number as externalUserId
            'x-pd-app-slug': resolvedAppName, // Specify which app's tool we're calling
          }
        }
      }
    )

    // Create MCP client
    const client = new Client({
      name: 'my-padi',
      version: '1.0.0'
    })

    try {
      // Initialize connection with transport
      await client.connect(transport as any)

      // Execute the tool via MCP client
      const result = await client.callTool({
        name: actualToolName,
        arguments: args
      })

      // Format result for AI SDK
      // MCP tool results are typically in { content: [...] } format
      const resultContent = Array.isArray(result.content) ? result.content : []
      const resultText = resultContent
        .map((item: any) => {
          if (typeof item === 'string') return item
          if (item.text) return item.text
          if (item.type === 'text') return item.text
          return JSON.stringify(item)
        })
        .join('\n')

      return {
        result: resultText || JSON.stringify(result)
      }
    } finally {
      // Always close client connection
      await client.close().catch(() => {})
    }
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : 'Unknown error executing tool'
    }
  }
}
