import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getUserByPhone } from '@/lib/db/users'
import { getSignupState, setSignupState, clearSignupState } from '@/lib/db/signup-states'
import { createUser } from '@/lib/db/users'
import { getOrCreateConversation, getConversationWithMessages } from '@/lib/db/conversations'
import { saveUserMessage, saveAssistantMessage, saveToolMessage } from '@/lib/db/messages'
import { sendWhatsAppMessage, sendTypingIndicator } from '@/lib/channels/whatsapp/client'
import { extractSignupData } from '@/lib/ai/extract-signup-data'
import { processUserMessage } from '@/lib/ai/orchestrator'
import { initializePipedreamMCP } from '@/lib/mcp/pipedream-client'
import { executePipedreamTool } from '@/lib/mcp/tool-executor'
import {
  fetchCalendarListViaProxy,
  isCalendarListEventsTool,
  isCalendarCreateEventTool,
  createCalendarEventViaProxy,
} from '@/lib/mcp/calendar-list-via-proxy'
import { extractCalendarEventFromInstruction } from '@/lib/ai/extract-calendar-event'
import { createAndSendConnectLink } from '@/lib/connect/send-connect-link'
import { z } from 'zod'

// Allow up to 5 min with Fluid Compute enabled (Hobby max 300s). Vercel docs: fluid compute default/max 300s.
export const maxDuration = 300

/** Tools the AI can use: MCP tools from connected apps + send_connection_link when user asks to do something but isn't connected */
const SEND_CONNECTION_LINK_TOOL = {
  description: 'Send the user a link to connect an app (e.g. Gmail, Google Calendar). Use when they ask to do something (send email, create event) but have not connected that app yet. appName: gmail (email), google_calendar (calendar), slack (Slack).',
  isConnectionTool: true as const,
}

/** Derive a short status from the first tool's description. Truncate at a full sentence or word boundary, not mid-word. */
function getStatusForToolCalls(
  toolCalls: Array<{ toolName: string }>,
  tools: Record<string, { description?: string }>
): string {
  if (!toolCalls?.length) return 'Working on it...'
  const first = toolCalls[0]
  const def = first?.toolName ? tools[first.toolName] : undefined
  const desc = (def?.description || '').trim()
  if (!desc) return 'Working on it...'
  const max = 42
  if (desc.length <= max) return desc
  const atMax = desc.slice(0, max + 1)
  const lastSentenceEnd = atMax.lastIndexOf('. ')
  const lastSpace = atMax.lastIndexOf(' ')
  const cut =
    lastSentenceEnd > 0
      ? lastSentenceEnd + 1
      : lastSpace > 0
        ? lastSpace
        : max
  const trimmed = desc.slice(0, cut).trim()
  return trimmed.length > 0 ? trimmed + (trimmed.endsWith('.') ? '' : '...') : desc.slice(0, max).trim() + '...'
}

/**
 * Normalize args for calendar create tools (event or reminder) so the entry is single/one-time
 * unless the user explicitly asked for recurring.
 * Proof: Google Calendar API events.insert - "recurrence[] ... This field is omitted for
 * single events." https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 * Pipedream sub-agent can default to daily for both event and reminder tools.
 * Must match same tool names as isCalendarCreateEventTool (event + reminder).
 */
function normalizeCalendarCreateEventInstruction(
  toolName: string,
  args: Record<string, any>,
  appName?: string
): Record<string, any> {
  const isCalendarCreate =
    (appName === 'google_calendar' || /google_calendar|calendar/.test(toolName)) &&
    /create.*(event|calendar|reminder)|add.*(event|calendar|reminder)|set.*(event|reminder)/i.test(toolName)
  if (!isCalendarCreate || !args || typeof args !== 'object') return args
  const instruction = args.instruction
  if (typeof instruction !== 'string' || !instruction.trim()) return args
  const alreadyRecurring = /\b(recurring|every day|daily|weekly|monthly|repeat|RRULE|FREQ=)\b/i.test(instruction)
  if (alreadyRecurring) return args
  const noRecurrenceSuffix = ' Single one-time event only. Do not set recurrence or RRULE.'
  if (/one-off|single event|no recurrence|do not (set |add )?recurrence|omit recurrence/i.test(instruction)) {
    return args
  }
  return { ...args, instruction: instruction.trim() + noRecurrenceSuffix }
}

// GET - Webhook verification
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  console.log('[Webhook] GET verification attempt:', {
    mode,
    hasToken: !!token,
    hasChallenge: !!challenge,
    verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN
  })

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhook] Verification successful')
    return new Response(challenge, { status: 200 })
  }

  console.log('[Webhook] Verification failed:', {
    modeMatch: mode === 'subscribe',
    tokenMatch: token === verifyToken
  })
  return new Response('Forbidden', { status: 403 })
}

// POST - Receive messages
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Log webhook received
    console.log('[Webhook] POST received')
    console.log('[Webhook] Body structure:', {
      hasEntry: !!body.entry,
      entryLength: body.entry?.length,
      hasChanges: !!body.entry?.[0]?.changes,
      changesLength: body.entry?.[0]?.changes?.length,
      field: body.entry?.[0]?.changes?.[0]?.field
    })
    
    // Parse WhatsApp message
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (!message) {
      console.log('[Webhook] No message in payload - might be status update or other event')
      // Still return 200 to acknowledge receipt
      return NextResponse.json({ status: 'ok' })
    }
    
    console.log('[Webhook] Message from:', message.from, 'Type:', message.type)

    // Use phone number directly from WhatsApp (they send valid numbers)
    const phoneNumber = message.from.trim()
    const incomingMessageId: string | undefined = typeof message.id === 'string' ? message.id : undefined

    // Validate message length (prevent DoS)
    const messageText = (message.text?.body || '').trim()
    if (messageText.length > 1000) {
      await sendWhatsAppMessage(
        phoneNumber,
        'Your message is too long. Please keep it under 1000 characters.'
      )
      return NextResponse.json({ status: 'ok' })
    }

    // Get or create user
    let user = await getUserByPhone(phoneNumber)

    if (!user) {
      // New user - check if in signup flow
      const signupState = await getSignupState(phoneNumber)
      
      if (!signupState) {
        // Start signup flow
        await setSignupState(phoneNumber, 'email', null)
        await sendWhatsAppMessage(
          phoneNumber,
          '👋 Hi! I\'m My Padi, your AI assistant.\n\n' +
          'Let\'s get you started. What\'s your email address?\n\n' +
          '(We need it for receipts and important updates)'
        )
        return NextResponse.json({ status: 'ok' })
      }

      // Continue signup flow
      if (signupState.step === 'email') {
        // Try AI extraction first, fallback to direct validation
        let extractedEmail: string | null = null
        
        // First try direct validation (faster, no AI cost)
        if (isValidEmail(messageText)) {
          extractedEmail = messageText
        } else {
          // Use AI to extract email from natural language
          extractedEmail = await extractSignupData(messageText, 'email')
        }

        // Validate email format using Zod
        const emailSchema = z.string().email().max(254).transform(val => val.toLowerCase().trim())
        const emailResult = emailSchema.safeParse(extractedEmail)
        if (emailResult.success) {
          await setSignupState(phoneNumber, 'name', { email: emailResult.data })
          await sendWhatsAppMessage(
            phoneNumber,
            'Perfect! What\'s your name?'
          )
          return NextResponse.json({ status: 'ok' })
        } else {
          await sendWhatsAppMessage(
            phoneNumber,
            'I couldn\'t find a valid email address in your message. Please try again:\n\n' +
            'Example: "my email is yourname@example.com" or just "yourname@example.com"'
          )
          return NextResponse.json({ status: 'ok' })
        }
      }

      if (signupState.step === 'name') {
        // Always use AI extraction for names since natural language is too varied
        // Users might say "My name is Stanley", "I'm John", "Stanley", "call me Stan", etc.
        // AI handles all these cases reliably without hardcoding patterns
        const extractedName = await extractSignupData(messageText, 'name')

        // Validate name using Zod (length 2-100, no control characters)
        const nameSchema = z.string().min(2).max(100).trim().refine(
          (val) => !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(val),
          { message: 'Name contains invalid characters' }
        )
        const nameResult = nameSchema.safeParse(extractedName)
        
        if (nameResult.success) {
          const userName = nameResult.data
          
          const signupData = signupState.data as { email?: string } | null
          user = await createUser({
            phone_number: phoneNumber,
            email: signupData?.email || '',
            name: userName
          })
          await clearSignupState(phoneNumber)
          
          await sendWhatsAppMessage(
            phoneNumber,
            `🎉 Welcome ${userName}! You're all set.\n\n` +
            `I'm your AI assistant and I can help you with:\n` +
            `• Create calendar events\n` +
            `• Send emails\n` +
            `• Manage tasks\n` +
            `• And much more!\n\n` +
            `Try: "Create a meeting for Friday 5pm"`
          )
          return NextResponse.json({ status: 'ok' })
        } else {
          await sendWhatsAppMessage(
            phoneNumber,
            'I couldn\'t find a valid name in your message. Please try again:\n\n' +
            'Example: "my name is Stanley" or just "Stanley"'
          )
          return NextResponse.json({ status: 'ok' })
        }
      }
    }

    // Existing user - check for app connection requests first
    if (user) {
      // Check if user wants to connect an app (simple pattern matching)
      const connectMatch = messageText.match(/connect\s+(.+?)(?:\s|$|\.|!|\?)/i)
      if (connectMatch) {
        const appName = connectMatch[1].trim().toLowerCase()
        
        // Generate Connect Link
        try {
          const linkRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL || 'http://localhost:3000'}/api/connect/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber, appName })
          })
          
          const linkData = await linkRes.json()
          // API already sends the link via WhatsApp; only send a message on failure
          if (!linkData.success) {
            await sendWhatsAppMessage(
              phoneNumber,
              `❌ Failed to generate connection link. Please try again.`
            )
          }
        } catch (error) {
          console.error('[Connect] Error:', error)
          await sendWhatsAppMessage(
            phoneNumber,
            `❌ An error occurred. Please try again.`
          )
        }
        
        return NextResponse.json({ status: 'ok' })
      }
      
      // Not a connection request - process with AI
      // Return immediately, process in background
      waitUntil(processUserMessageAsync(
        user.id,
        phoneNumber,
        messageText,
        incomingMessageId,
        user.name || undefined
      ))
    }

    return NextResponse.json({ status: 'ok' })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

function isValidEmail(email: string): boolean {
  return z.string().email().safeParse(email).success
}

/**
 * Process user message asynchronously in background
 * Handles AI processing, tool execution, and WhatsApp messaging
 */
async function processUserMessageAsync(
  userId: string,
  phoneNumber: string,
  messageText: string,
  incomingMessageId: string | undefined,
  userName?: string
): Promise<void> {
  try {
    console.log('[AI] Processing message for user:', userId)
    
    // Show typing indicator while we process the message
    if (incomingMessageId) {
      await sendTypingIndicator(incomingMessageId)
    }
    
    // Get or create conversation
    const conversation = await getOrCreateConversation(userId)
    
    // Get conversation history (last 20 messages)
    const conversationWithHistory = await getConversationWithMessages(userId, 20)
    const messageHistory = conversationWithHistory?.messages || []
    
    // Save user message to database
    await saveUserMessage(conversation.id, messageText)
    
    // Initialize Pipedream MCP and get tools
    let mcpTools: Record<string, any>
    let cleanupMCP: () => Promise<void>
    try {
      const mcp = await initializePipedreamMCP(userId, phoneNumber)
      mcpTools = mcp.tools
      cleanupMCP = mcp.cleanup
      console.log('[AI] MCP initialized, tools count:', Object.keys(mcpTools).length)
    } catch (mcpError) {
      const err = mcpError instanceof Error ? mcpError : new Error(String(mcpError))
      console.error('[AI] initializePipedreamMCP failed:', err.message)
      if (err.stack) console.error('[AI] MCP init stack:', err.stack)
      throw mcpError
    }
    const toolsForAi = { ...mcpTools, send_connection_link: SEND_CONNECTION_LINK_TOOL }

    try {
      // Multi-round tool loop: we run tools in the webhook (not in SDK execute) and re-call
      // processUserMessage until we get a text response. Aligned with Vercel AI SDK "forward
      // tool calls to client/queue" pattern — see lib/ai/TOOL_LOOP_AND_VERCEL_DOCS.md
      const MAX_TOOL_ROUNDS = 3
      let aiResult = await processUserMessage(
        messageText,
        userId,
        messageHistory,
        userName,
        toolsForAi,
        phoneNumber
      )
      let round = 0

      // Run tool calls in a loop so we handle multiple rounds (e.g. model asks for another tool after seeing first result)
      while (aiResult && aiResult.toolCalls && aiResult.toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
        round++
        // Save the assistant message that contains the tool calls
        await saveAssistantMessage(
          conversation.id,
          aiResult.response || null,
          aiResult.toolCalls
        )
        // Typing once before status (docs: typing dismissed when we send a reply). See lib/channels/whatsapp/TYING_AND_STATUS.md
        if (incomingMessageId) await sendTypingIndicator(incomingMessageId)
        const statusMessage = getStatusForToolCalls(aiResult.toolCalls, toolsForAi)
        await sendWhatsAppMessage(phoneNumber, `🔄 ${statusMessage}`)
        if (incomingMessageId) await sendTypingIndicator(incomingMessageId) // best-effort; may not show after our reply

        for (const toolCall of aiResult.toolCalls) {
          try {
            let toolResultText: string
            if (toolCall.toolName === 'send_connection_link') {
              const appName = (toolCall.args?.appName ?? '').toString().trim() || 'gmail'
              const linkResult = await createAndSendConnectLink(phoneNumber, appName)
              toolResultText = linkResult.success
                ? `Connection link for ${appName} sent to the user on WhatsApp.`
                : `Failed to send link: ${linkResult.error ?? 'Unknown error'}`
            } else {
              const toolDef = mcpTools[toolCall.toolName]
              const appName = toolDef?.appName
              // Calendar list events: use Connect API Proxy (bounded timeMin/timeMax) to avoid 30s timeout
              if (isCalendarListEventsTool(toolCall.toolName, appName)) {
                const proxyResult = await fetchCalendarListViaProxy(
                  userId,
                  phoneNumber
                )
                if (proxyResult.error) {
                  toolResultText = proxyResult.error
                } else {
                  const r = proxyResult.result
                  toolResultText =
                    r == null
                      ? 'No calendar data returned.'
                      : typeof r === 'string'
                        ? r
                        : JSON.stringify(r)
                }
              } else if (
                isCalendarCreateEventTool(toolCall.toolName, appName)
              ) {
                const args = toolCall.args ?? {}
                const instruction =
                  (typeof args.instruction === 'string' ? args.instruction : typeof (args as { input?: string }).input === 'string' ? (args as { input: string }).input : '').trim()
                const normalized = instruction.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
                const hasOneOff =
                  /\bnon[- ]?recurring\b/i.test(normalized) ||
                  /\bno recurrence\b/i.test(normalized) ||
                  /\bone[- ]?off\b/i.test(normalized) ||
                  /\bsingle\b/i.test(normalized) && /\bevent\b/i.test(normalized) ||
                  /\bdo not repeat\b/i.test(normalized) ||
                  /\bdon't repeat\b/i.test(normalized) ||
                  /\bwithout repeat\b/i.test(normalized) ||
                  /\bno repeat\b/i.test(normalized)
                const hasRecurring =
                  /\bevery day\b/i.test(normalized) ||
                  /\bdaily\b/i.test(normalized) ||
                  /\bweekly\b/i.test(normalized) ||
                  /\bmonthly\b/i.test(normalized) ||
                  (/\brepeat\b/i.test(normalized) && !/\b(do not|don't|no|without)\s+repeat\b/i.test(normalized)) ||
                  /\bRRULE\b/i.test(normalized) ||
                  /\bFREQ=\b/i.test(normalized)
                const wantsRecurring = !hasOneOff && hasRecurring
                console.log('[Calendar create]', {
                  toolName: toolCall.toolName,
                  appName,
                  instructionLen: instruction.length,
                  instructionPreview: instruction.slice(0, 80),
                  wantsRecurring,
                })
                if (!wantsRecurring && instruction) {
                  const extracted = await extractCalendarEventFromInstruction(instruction)
                  console.log('[Calendar create] extraction', { extracted: !!extracted, path: extracted ? 'proxy' : 'MCP (extraction failed)' })
                  if (extracted) {
                    console.log('[Calendar create] calling createCalendarEventViaProxy (single event, no recurrence)')
                    const createResult = await createCalendarEventViaProxy(
                      userId,
                      phoneNumber,
                      {
                        summary: extracted.summary,
                        startDateTime: extracted.startDateTime,
                        endDateTime: extracted.endDateTime,
                        ...(extracted.attendees?.length && { attendees: extracted.attendees }),
                      }
                    )
                    if (createResult.error) {
                      toolResultText = createResult.error
                    } else {
                      const r = createResult.result
                      toolResultText =
                        r == null
                          ? 'Event created.'
                          : typeof r === 'string'
                            ? r
                            : (r as { htmlLink?: string })?.htmlLink
                              ? `Event created: ${(r as { htmlLink: string }).htmlLink}`
                              : JSON.stringify(r)
                    }
                  } else {
                    const normalizedArgs = normalizeCalendarCreateEventInstruction(
                      toolCall.toolName,
                      args,
                      appName
                    )
                    const toolResult = await executePipedreamTool(
                      userId,
                      phoneNumber,
                      toolCall.toolName,
                      normalizedArgs,
                      appName
                    )
                    toolResultText =
                      toolResult.error || toolResult.result || 'Tool executed'
                  }
                } else {
                  console.log('[Calendar create] path', { reason: !instruction ? 'empty instruction' : 'wantsRecurring', path: 'MCP' })
                  const normalizedArgs = normalizeCalendarCreateEventInstruction(
                    toolCall.toolName,
                    args,
                    appName
                  )
                  const toolResult = await executePipedreamTool(
                    userId,
                    phoneNumber,
                    toolCall.toolName,
                    normalizedArgs,
                    appName
                  )
                  toolResultText =
                    toolResult.error || toolResult.result || 'Tool executed'
                }
              } else {
                const normalizedArgs = normalizeCalendarCreateEventInstruction(
                  toolCall.toolName,
                  toolCall.args ?? {},
                  appName
                )
                const toolResult = await executePipedreamTool(
                  userId,
                  phoneNumber,
                  toolCall.toolName,
                  normalizedArgs,
                  appName
                )
                toolResultText =
                  toolResult.error || toolResult.result || 'Tool executed'
              }
            }

            await saveToolMessage(
              conversation.id,
              toolCall.toolCallId,
              toolCall.toolName,
              toolResultText
            )
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            console.error(`[AI] Error executing tool ${toolCall.toolName}:`, err.message)
            if (err.stack) console.error('[AI] Tool error stack:', err.stack)
            await saveToolMessage(
              conversation.id,
              toolCall.toolCallId,
              toolCall.toolName,
              `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            )
          }
        }

        const updatedHistory = await getConversationWithMessages(userId, 20)
        const updatedMessageHistory = updatedHistory?.messages || []
        aiResult = await processUserMessage(
          messageText,
          userId,
          updatedMessageHistory,
          userName,
          toolsForAi,
          phoneNumber
        )
      }

      if (aiResult && aiResult.response && aiResult.response.trim()) {
        await saveAssistantMessage(
          conversation.id,
          aiResult.response,
          aiResult.toolCalls
        )
        await sendWhatsAppMessage(phoneNumber, aiResult.response)
      } else {
        console.error('[AI] No response from processUserMessage:', {
          hasResult: !!aiResult,
          hasResponse: aiResult ? !!aiResult.response : false,
          toolCallsCount: aiResult?.toolCalls?.length ?? 0,
          rounds: round,
        })
        // If we ran tools this turn, show a friendly fallback instead of generic error
        const ranToolsThisTurn = round > 0
        await sendWhatsAppMessage(
          phoneNumber,
          ranToolsThisTurn
            ? "I've completed the action. If something didn't work as expected or you need something else, just tell me."
            : 'Sorry, I encountered an error processing your message. Please try again.'
        )
      }
    } finally {
      await cleanupMCP()
    }
  } catch (error) {
    // Log full error so it appears in Vercel server logs (message + stack)
    const err = error instanceof Error ? error : new Error(String(error))
    console.error('[AI] Error processing message:', err.message)
    if (err.stack) console.error('[AI] Stack:', err.stack)
    await sendWhatsAppMessage(
      phoneNumber,
      'Sorry, I encountered an error processing your message. Please try again.'
    )
  }
}
