import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import type { ModelMessage } from '@ai-sdk/provider-utils'

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
 * Supports tool calling format (ready for future tool integration)
 */
export async function processUserMessage(
  userMessage: string,
  userId: string,
  messageHistory: Message[],
  userName?: string
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

    // System prompt for My Padi assistant
    const systemPrompt = `You are My Padi, a helpful AI assistant available on WhatsApp. You help users with productivity tasks like:
- Creating calendar events
- Sending emails
- Managing tasks
- Answering questions
- Providing helpful information

Be friendly, concise, and helpful. Keep responses appropriate for WhatsApp (not too long). 
${userName ? `The user's name is ${userName}.` : ''}

If the user asks about features that require integrations (like calendar or email), let them know these features are coming soon.`

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

    const result = await generateText({
      model: openai('gpt-5.2'),
      system: systemPrompt,
      messages: messages,
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

