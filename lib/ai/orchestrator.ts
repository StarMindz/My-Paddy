import { generateText, tool, jsonSchema } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import type { ModelMessage } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import { executePipedreamTool } from '@/lib/mcp/tool-executor'

// Message type from Prisma (will be available after db:generate)
type Message = {
  id: string
  conversationId: string
  role: string
  content: string | null
  toolCalls: any
  toolCallId: string | null
  toolName: string | null
  createdAt: Date
}

/**
 * Process user message with AI and return response
 * Uses conversation history for context
 * Supports tool calling with Pipedream MCP tools
 */
export async function processUserMessage(
  userMessage: string,
  userId: string,
  messageHistory: Message[],
  userName?: string,
  tools?: Record<string, any>,
  phoneNumber?: string // Phone number for Pipedream externalUserId
): Promise<{ response: string; toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, any> }> } | null> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[AI] OPENAI_API_KEY not configured')
      return null
    }

    // Basic input validation
    if (!userMessage || typeof userMessage !== 'string' || userMessage.length > 1000) {
      console.error('[AI] processUserMessage: validation failed (missing, not string, or >1000 chars)')
      return null
    }
    const trimmedMessage = userMessage.trim()
    if (!trimmedMessage) {
      console.error('[AI] processUserMessage: validation failed (empty after trim)')
      return null
    }

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    // Build system prompt - simple and clear
    const hasConnectionTool = tools && 'send_connection_link' in tools
    const mcpToolEntries = tools
      ? Object.entries(tools).filter(([name]) => name !== 'send_connection_link')
      : []
    const toolDescriptions =
      mcpToolEntries.length > 0
        ? mcpToolEntries
            .map(([toolName, toolDef]) => {
              const cleanName = toolName.replace(/^pd_/, '')
              return `- ${cleanName}: ${toolDef.description || 'Available tool'}`
            })
            .join('\n')
        : null

    const connectionInstruction = hasConnectionTool
      ? `\n\n## When the user is NOT connected\nYou have a tool \`send_connection_link\` with parameter \`appName\` (app slug). Use it when the user asks to do something that requires an app they have not connected yet (e.g. "send an email" → use appName \`gmail\`; "create a calendar event" or "add a meeting" → use \`google_calendar\`; Slack → \`slack\`). After calling it, tell them you sent a link to connect and they can try their request again after connecting. Do not ask them to "say connect gmail"—just call the tool and send the link.`
      : ''

    const systemPrompt = `You are My Padi, a helpful AI assistant on WhatsApp. You help users with tasks like creating calendar events, sending emails, and managing their productivity.

${userName ? `The user's name is ${userName}.` : ''}

${toolDescriptions
  ? `## Available Tools (user has these apps connected)\n\n${toolDescriptions}\n\nWhen the user requests an action (e.g. "send an email to X", "create a meeting tomorrow"), use the appropriate tool above and confirm what you did.`
  : ''}${connectionInstruction}${!toolDescriptions && !hasConnectionTool ? `\n\nTo use features like calendar or email, users need to connect their accounts first. If they ask about these features, offer to send them a connection link.` : ''}

## Tool Parameters (MANDATORY)

- NEVER call any tool with an empty payload {}. Every required parameter must be filled.
- Crosscheck tool parameters against the tool's schema before calling; do not make mistakes in the parameters.
- If a tool requires specific information (like an email address, subject, or body), ensure you have gathered that from the user or the conversation history before calling the tool.

## Proactive Behavior

- Do NOT ask the user for "exact fields" once you have the basic details. Build the tool parameters yourself and call the tool immediately.
- After a clear "yes", "send", "go ahead", or "confirm" from the user, call the tool once with the full parameters. Do not ask for confirmation again.
- Take initiative. If you have a plan, execute it or present it clearly. Don't frustrate the user with redundant questions.
- If you need information to complete a task, ask for it all at once rather than one by one.
- Once you have enough information to form a plan, tell the user the plan and ask for a final "Go ahead" before executing sensitive actions like sending an email or deleting something.

## Formatting

Use WhatsApp formatting:
- *Bold* with single asterisks
- _Italic_ with underscores
- \`Code\` with backticks
- \`\`\`Code blocks\`\`\` with triple backticks

Keep responses short and friendly.`

    // Set of tool names we're passing this request (SDK errors if history has tool results for tools not in this set)
    const currentToolNames = new Set(Object.keys(tools || {}))

    // Convert database messages to Vercel AI SDK format (ModelMessage)
    // Only include tool calls and tool results for tools in currentToolNames to avoid "No tool call found for function call output"
    const messages: ModelMessage[] = []
    for (const msg of messageHistory) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        const toolCallsArray = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
        const toolCallParts = toolCallsArray
          .filter((tc: any) => currentToolNames.has(tc.toolName || ''))
          .map((tc: any) => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId || '',
            toolName: tc.toolName || '',
            input: tc.input || tc.args || {}
          }))
        if (toolCallParts.length === 0 && !msg.content) continue
        const content: string | Array<any> =
          msg.content && toolCallParts.length > 0
            ? [{ type: 'text' as const, text: msg.content }, ...toolCallParts]
            : msg.content
            ? msg.content
            : toolCallParts.length > 0
            ? toolCallParts
            : ''
        messages.push({
          role: 'assistant' as const,
          content: content
        })
      } else if (msg.role === 'tool') {
        if (!currentToolNames.has(msg.toolName || '')) continue
        messages.push({
          role: 'tool' as const,
          content: [{
            type: 'tool-result' as const,
            toolCallId: msg.toolCallId || '',
            toolName: msg.toolName || '',
            output: {
              type: 'text' as const,
              value: msg.content || ''
            }
          }]
        })
      } else if (msg.role === 'user') {
        messages.push({
          role: 'user' as const,
          content: msg.content || ''
        })
      } else {
        messages.push({
          role: 'system' as const,
          content: msg.content || ''
        })
      }
    }

    // Add current user message
    messages.push({
      role: 'user',
      content: trimmedMessage
    })

    // Convert tools to Vercel AI SDK tool format
    // MCP tools: execute via Pipedream. send_connection_link: executed in webhook, schema only here
    const aiTools: Record<string, any> = {}
    if (tools) {
      for (const [toolName, toolDef] of Object.entries(tools)) {
        if (toolDef.isConnectionTool) {
          // send_connection_link: AI calls it; webhook executes it (createAndSendConnectLink)
          const connectionSchema = z.object({ appName: z.string().describe('App slug: gmail (email), google_calendar (calendar), slack (Slack), etc.') })
          aiTools[toolName] = tool({
            description: toolDef.description || 'Send the user a link to connect an app.',
            inputSchema: connectionSchema,
            execute: async (_params: z.infer<typeof connectionSchema>) => 'Connection link will be sent by the system.'
          })
          continue
        }
        const toolDefinition = {
          description: toolDef.description || `Execute ${toolName}`,
          inputSchema: jsonSchema(toolDef.inputSchema),
          execute: async (params: any) => {
            if (!phoneNumber) {
              return 'Error: Phone number required for tool execution'
            }
            const result = await executePipedreamTool(
              userId,
              phoneNumber,
              toolName,
              params as Record<string, any>,
              toolDef.appName
            )
            if (result.error) {
              return `Error: ${result.error}`
            }
            return result.result || 'Tool executed successfully'
          }
        }
        aiTools[toolName] = tool(toolDefinition)
      }
    }

    const result = await generateText({
      model: openai('gpt-5.2'),
      system: systemPrompt,
      messages: messages,
      tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
    })

    const response = (result.text ?? '').trim()
    const toolCalls = result.toolCalls && result.toolCalls.length > 0
      ? result.toolCalls.map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: 'args' in tc ? (tc.args as Record<string, any>) : ('input' in tc ? (tc.input as Record<string, any>) : {})
        }))
      : undefined

    // When model returns only tool calls (no text), we must still return toolCalls so the webhook can run them
    if (!response && (!toolCalls || toolCalls.length === 0)) {
      console.error('[AI] processUserMessage: generateText returned no text and no tool calls')
      return null
    }

    return {
      response: response || '',
      toolCalls
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    console.error('[AI] processUserMessage exception:', err.message)
    if (err.stack) console.error('[AI] processUserMessage stack:', err.stack)
    return null
  }
}

