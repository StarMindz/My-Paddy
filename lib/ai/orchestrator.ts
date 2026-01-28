import { generateText, tool } from 'ai'
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
      return null
    }

    const trimmedMessage = userMessage.trim()
    if (!trimmedMessage) {
      return null
    }

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    // Build system prompt - simple and clear
    const toolDescriptions = tools && Object.keys(tools).length > 0
      ? Object.entries(tools)
          .map(([toolName, toolDef]) => {
            const cleanName = toolName.replace(/^pd_/, '') // Remove pd_ prefix for display
            return `- ${cleanName}: ${toolDef.description || 'Available tool'}`
          })
          .join('\n')
      : null

    const systemPrompt = `You are My Padi, a helpful AI assistant on WhatsApp. You help users with tasks like creating calendar events, sending emails, and managing their productivity.

${userName ? `The user's name is ${userName}.` : ''}

${toolDescriptions 
  ? `## Available Tools\n\n${toolDescriptions}\n\nWhen a user requests an action, use the appropriate tool automatically. Confirm what you did after completing the action.` 
  : `To use features like calendar events or emails, users need to connect their accounts first. If they ask about these features, offer to send them a connection link.`}

## Formatting

Use WhatsApp formatting:
- *Bold* with single asterisks
- _Italic_ with underscores
- \`Code\` with backticks
- \`\`\`Code blocks\`\`\` with triple backticks

Keep responses short and friendly.`

    // Convert database messages to Vercel AI SDK format (ModelMessage)
    const messages: ModelMessage[] = messageHistory.map((msg) => {
      if (msg.role === 'assistant' && msg.toolCalls) {
        // Assistant message with tool calls
        // AssistantContent can be string or array with ToolCallPart
        const toolCallsArray = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
        const toolCallParts = toolCallsArray.map((tc: any) => ({
          type: 'tool-call' as const,
          toolCallId: tc.toolCallId || '',
          toolName: tc.toolName || '',
          input: tc.input || tc.args || {}
        }))
        
        // If there's text content, combine with tool calls as array
        // TextPart format: { type: 'text', text: string }
        const content: string | Array<any> = msg.content
          ? [{ type: 'text' as const, text: msg.content }, ...toolCallParts]
          : toolCallParts.length > 0
          ? toolCallParts
          : ''
        
        return {
          role: 'assistant' as const,
          content: content
        }
      } else if (msg.role === 'tool') {
        // Tool result message
        // ToolContent is array of ToolResultPart
        return {
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
        }
      } else if (msg.role === 'user') {
        // User message
        return {
          role: 'user' as const,
          content: msg.content || ''
        }
      } else {
        // System message (shouldn't be in history, but handle it)
        return {
          role: 'system' as const,
          content: msg.content || ''
        }
      }
    })

    // Add current user message
    messages.push({
      role: 'user',
      content: trimmedMessage
    })

    // Convert MCP tools to Vercel AI SDK tool format
    // Note: MCP tools use JSON Schema, we'll use a simple Zod object schema
    const aiTools: Record<string, any> = {}
    if (tools) {
      for (const [toolName, toolDef] of Object.entries(tools)) {
        // Create a simple Zod schema from JSON Schema (simplified approach)
        // For production, you'd want a proper JSON Schema to Zod converter
        const zodSchema = z.object({}).passthrough() // Accept any object for now
        
        // Create tool with proper typing
        // toolDef.appName is stored when tools are retrieved from MCP
        const toolDefinition = {
          description: toolDef.description || `Execute ${toolName}`,
          inputSchema: zodSchema,
          execute: async (params: z.infer<typeof zodSchema>) => {
            // Execute tool via MCP
            // Pass appName if available (stored when tool was retrieved)
            // Use phoneNumber as externalUserId for Pipedream
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

    const response = result.text.trim()
    
    if (!response) {
      return null
    }

    // Extract tool calls if any (for future tool calling support)
    // TypedToolCall has toolCallId, toolName, and args (for static) or input (for dynamic)
    const toolCalls = result.toolCalls && result.toolCalls.length > 0
      ? result.toolCalls.map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: 'args' in tc ? (tc.args as Record<string, any>) : ('input' in tc ? (tc.input as Record<string, any>) : {})
        }))
      : undefined

    return {
      response,
      toolCalls
    }
  } catch (error) {
    console.error('[AI] Error processing user message:', error)
    return null
  }
}

