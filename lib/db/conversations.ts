import { getPrismaClient } from './client'

// Conversation type - matches Prisma schema
// Will be available from @prisma/client after running: npm run db:generate
type Conversation = {
  id: string
  userId: string
  createdAt: Date
  updatedAt: Date
}

export interface ConversationWithMessages {
  id: string
  userId: string
  createdAt: Date
  updatedAt: Date
  messages: Array<{
    id: string
    conversationId: string
    role: string
    content: string | null
    toolCalls: any
    toolCallId: string | null
    toolName: string | null
    createdAt: Date
  }>
}

// Get or create conversation for a user
export async function getOrCreateConversation(userId: string): Promise<Conversation> {
  const prisma = getPrismaClient() as any
  
  // Try to find existing conversation
  let conversation = await prisma.conversation.findUnique({
    where: {
      userId: userId
    }
  })

  // Create if doesn't exist
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        userId: userId
      }
    })
  }

  return conversation
}

// Get conversation with recent messages (last N messages)
// Ensures correct chronological order and preserves tool call chains
// Optimized: Single database call with buffer for completeness
export async function getConversationWithMessages(
  userId: string,
  limit: number = 20
): Promise<ConversationWithMessages | null> {
  const prisma = getPrismaClient() as any
  
  // Strategy: Fetch conversation + messages in ONE database call using include
  // Then process in memory to find complete sequences and return last N
  // This minimizes database calls and reduces latency
  
  // Fetch buffer of messages (e.g., if limit=20, fetch last 40 messages)
  // Fetch in DESC order (newest first), then reverse to chronological
  const bufferSize = limit * 2
  
  const conversation = await prisma.conversation.findUnique({
    where: {
      userId: userId
    },
    include: {
      messages: {
        orderBy: {
          createdAt: 'desc'
        },
        take: bufferSize
      }
    }
  })

  if (!conversation) {
    return null
  }

  // Reverse messages to get chronological order (oldest to newest)
  // Create a copy to avoid mutating the original array
  const allMessages = [...conversation.messages].reverse()

  if (allMessages.length === 0) {
    const { messages: _, ...conversationData } = conversation
    return {
      ...conversationData,
      messages: []
    }
  }

  // If we have fewer messages than buffer, return all
  if (allMessages.length <= limit) {
    const { messages: _, ...conversationData } = conversation
    return {
      ...conversationData,
      messages: allMessages
    }
  }

  // Get last N messages from the buffer
  let messages = allMessages.slice(-limit)

  // Check if we cut in the middle of a tool call sequence
  // Tool call sequence rules:
  // 1. Assistant (with tool calls) → Tool results → Assistant (final response)
  // 2. We can't have a tool result without its assistant
  // 3. We can't have an assistant with tool calls without all its tool results
  
  // Process in memory (no more database calls)
  if (messages.length > 0) {
    const firstMessage = messages[0]
    const firstMessageIndex = allMessages.findIndex(m => m.id === firstMessage.id)

    // Case 1: First message is a tool result - we need the assistant that called it
    if (firstMessage.role === 'tool' && firstMessage.toolCallId) {
      // Search backwards in allMessages to find the assistant that called this tool
      for (let i = firstMessageIndex - 1; i >= 0; i--) {
        const candidate = allMessages[i]
        if (candidate.role === 'assistant' && candidate.toolCalls) {
          const toolCalls = Array.isArray(candidate.toolCalls) ? candidate.toolCalls : []
          const toolCallIds = toolCalls.map((tc: any) => tc.toolCallId || tc.id).filter(Boolean)
          
          if (toolCallIds.includes(firstMessage.toolCallId)) {
            // Found the assistant! Get all messages from this assistant onwards
            messages = allMessages.slice(i)
            // Take last N messages from this complete sequence
            if (messages.length > limit) {
              messages = messages.slice(-limit)
            }
            break
          }
        }
      }
    }

    // Case 2: First message is an assistant with tool calls - ensure we have all tool results
    if (messages[0].role === 'assistant' && messages[0].toolCalls) {
      const toolCalls = Array.isArray(messages[0].toolCalls) ? messages[0].toolCalls : []
      const toolCallIds = toolCalls.map((tc: any) => tc.toolCallId || tc.id).filter(Boolean)
      
      if (toolCallIds.length > 0) {
        // Count tool results in our sequence
        const toolResultsInSequence = messages.filter(
          m => m.role === 'tool' && m.toolCallId && toolCallIds.includes(m.toolCallId)
        )
        
        // If we're missing tool results, search forward in allMessages
        if (toolResultsInSequence.length < toolCallIds.length) {
          // Get all messages from this assistant onwards from the buffer
          const assistantIndex = allMessages.findIndex(m => m.id === messages[0].id)
          if (assistantIndex >= 0) {
            messages = allMessages.slice(assistantIndex)
            // Take last N messages from this complete sequence
            if (messages.length > limit) {
              messages = messages.slice(-limit)
            }
          }
        }
      }
    }
  }

  // Final step: Ensure we don't exceed reasonable bounds
  // If somehow we have more than limit * 1.5, trim to last N
  if (messages.length > limit * 1.5) {
    messages = messages.slice(-limit)
  }

  // Extract conversation data without messages (since we're setting our own)
  const { messages: _, ...conversationData } = conversation
  
  return {
    ...conversationData,
    messages: messages
  }
}

