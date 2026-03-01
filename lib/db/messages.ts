import { getPrismaClient } from './client'
import { getOrCreateConversation } from './conversations'

// Message type - matches Prisma schema
// Will be available from @prisma/client after running: npm run db:generate
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

// Save a user message
export async function saveUserMessage(
  conversationId: string,
  content: string
): Promise<Message> {
  const prisma = getPrismaClient() as any
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: 'user',
      content: content
    }
  })
}

// Save an assistant message (with optional tool calls)
// Stored format: { type: 'tool-call', toolCallId, toolName, input } (input = args per ModelMessage; orchestrator reads args ?? input)
export async function saveAssistantMessage(
  conversationId: string,
  content: string | null,
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    args: Record<string, any>
  }>
): Promise<Message> {
  // Convert tool calls to ToolCallPart format for storage
  const toolCallsFormatted = toolCalls
    ? toolCalls.map(tc => ({
        type: 'tool-call' as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.args
      }))
    : null

  const prisma = getPrismaClient() as any
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: 'assistant',
      content: content,
      toolCalls: toolCallsFormatted as any
    }
  })
}

// Save a tool result message
export async function saveToolMessage(
  conversationId: string,
  toolCallId: string,
  toolName: string,
  content: string
): Promise<Message> {
  const prisma = getPrismaClient() as any
  return await prisma.message.create({
    data: {
      conversationId: conversationId,
      role: 'tool',
      content: content,
      toolCallId: toolCallId,
      toolName: toolName
    }
  })
}

// Get recent messages for a conversation
export async function getRecentMessages(
  conversationId: string,
  limit: number = 20
): Promise<Message[]> {
  const prisma = getPrismaClient() as any
  return await prisma.message.findMany({
    where: {
      conversationId: conversationId
    },
    orderBy: {
      createdAt: 'asc'
    },
    take: limit
  })
}

/**
 * Append an outbound message (reminder or morning brief) to the user's conversation so the AI has context.
 * Saves: (1) a marker user message, (2) the assistant message with the exact text we sent.
 * When the user asks follow-ups like "What did you remind me about?" or "What did you say this morning?", the AI sees this turn.
 */
const OUTBOUND_MARKERS: Record<'reminder' | 'morning_brief', string> = {
  reminder: '[Reminder delivered]',
  morning_brief: '[Morning brief delivered]',
}
const OUTBOUND_FALLBACKS: Record<'reminder' | 'morning_brief', string> = {
  reminder: 'Reminder.',
  morning_brief: 'Good morning.',
}

export async function appendOutboundToConversation(
  userId: string,
  kind: 'reminder' | 'morning_brief',
  content: string
): Promise<void> {
  const conversation = await getOrCreateConversation(userId)
  const prisma = getPrismaClient() as any
  const marker = OUTBOUND_MARKERS[kind]
  const assistantContent = (content || '').trim() || OUTBOUND_FALLBACKS[kind]
  await prisma.message.createMany({
    data: [
      { conversationId: conversation.id, role: 'user', content: marker },
      { conversationId: conversation.id, role: 'assistant', content: assistantContent },
    ],
  })
}

