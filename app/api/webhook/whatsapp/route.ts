import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { experimental_transcribe as transcribe } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getUserByPhone } from '@/lib/db/users'
import { getSignupState, setSignupState, clearSignupState } from '@/lib/db/signup-states'
import { createUser } from '@/lib/db/users'
import { getOrCreateConversation, getConversationWithMessages } from '@/lib/db/conversations'
import { saveUserMessage, saveAssistantMessage, saveToolMessage } from '@/lib/db/messages'
import { sendWhatsAppMessage, sendTypingIndicator } from '@/lib/channels/whatsapp/client'
import { downloadWhatsAppMedia } from '@/lib/channels/whatsapp/media'
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
import { createAndSendConnectLink, searchConnectableApps } from '@/lib/connect/send-connect-link'
import { getTimezoneFromPhone } from '@/lib/context/user-context'
import { getMemoriesForTurn, retain, markRecalled, type MemoryItem } from '@/lib/memory'
import { createReminder, createCalendarNudgeReminders } from '@/lib/reminders'
import { getAppConnection } from '@/lib/db/app-connections'
import { isPipedreamEnabled } from '@/lib/config/integrations'
import {
  sendEmail,
  createDraft,
  listMessages,
  listLabels,
  createLabel,
  archiveMessage,
  deleteMessage,
  addLabelsToMessage,
  removeLabelsFromMessage,
  listThreadMessages,
  listSendAsAliases,
  getSendAsAlias,
  updatePrimarySignature,
} from '@/lib/google/gmail'
import { createCalendarEvent, listCalendarEvents } from '@/lib/google/calendar'
import { z } from 'zod'

// Allow up to 5 min with Fluid Compute enabled (Hobby max 300s). Vercel docs: fluid compute default/max 300s.
export const maxDuration = 300

/** Tools the AI can use: MCP tools from connected apps + connect tools when user asks to do something but isn't connected */
const SEND_CONNECTION_LINK_TOOL = {
  description:
    'Send the user a fresh connect link for one app. Works for any Pipedream app (1000+). Use after you have chosen a specific app slug (e.g. "gmail", "google-calendar", "slack", "notion") from search_connectable_apps. Parameter appSlug: the exact slug of the app to connect. For multi-app requests (e.g. "save to Sheets and notify on Slack"), call this tool once per unconnected app. You must always call this tool to generate a new link; never output or repeat a link from earlier in the conversation (links expire in 4 hours).',
  isConnectionTool: true as const,
}

const SEARCH_CONNECTABLE_APPS_TOOL = {
  description:
    'Search for Pipedream apps the user might want to connect. Call this when the user asks to connect or use an app (e.g. "calendar", "Gmail", "Notion") and you need to see the available options. Parameter query: short phrase describing the app (e.g. "google calendar", "gmail", "notion"). Use the returned app slugs when calling send_connection_link.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Short phrase describing the app to search for (e.g. "google calendar", "gmail", "notion").',
      },
    },
    required: ['query'],
  },
}

const GMAIL_TOOLS: Record<string, { description: string; inputSchema: any }> = {
  gmail_send_email: {
    description:
      'Send an email from the user via Gmail. Use when the user clearly asks you to send an email and has already confirmed the final To, Subject, and Body.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address (e.g. "user@example.com").',
        },
        subject: {
          type: 'string',
          description: 'Short subject line for the email.',
        },
        body: {
          type: 'string',
          description: 'Plain-text body of the email.',
        },
        cc: {
          type: 'string',
          description: 'Optional CC recipients as a comma-separated list.',
        },
        bcc: {
          type: 'string',
          description: 'Optional BCC recipients as a comma-separated list.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  gmail_create_draft: {
    description:
      'Create an email draft in Gmail without sending it. Use when the user wants to review or send the email later.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address (e.g. "user@example.com").',
        },
        subject: {
          type: 'string',
          description: 'Short subject line for the email.',
        },
        body: {
          type: 'string',
          description: 'Plain-text body of the email.',
        },
        cc: {
          type: 'string',
          description: 'Optional CC recipients as a comma-separated list.',
        },
        bcc: {
          type: 'string',
          description: 'Optional BCC recipients as a comma-separated list.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  gmail_find_email: {
    description:
      'Search the user’s Gmail inbox for messages matching a Gmail search query (e.g. from:, subject:, has:attachment). Use this when the user asks you to find or reference an existing email.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Gmail search query string (e.g. "from:john@example.com subject:invoice").',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of messages to return (default 20, max 100).',
        },
      },
      required: ['query'],
    },
  },
  gmail_list_labels: {
    description:
      'List all labels in the user’s Gmail account. Use when you need to know which labels exist before adding/removing them on messages.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  gmail_create_label: {
    description:
      'Create a new Gmail label. Use when the user wants a new label created for organizing email.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the Gmail label to create.',
        },
      },
      required: ['name'],
    },
  },
  gmail_archive_email: {
    description:
      'Archive a Gmail message (remove it from the Inbox but keep it in All Mail).',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Gmail message ID to archive.',
        },
      },
      required: ['messageId'],
    },
  },
  gmail_delete_email: {
    description:
      'Permanently delete a Gmail message. Use only when the user clearly asks to delete.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Gmail message ID to delete.',
        },
      },
      required: ['messageId'],
    },
  },
  gmail_add_label_to_email: {
    description:
      'Add one or more Gmail labels to a specific message. Use existing labels from gmail_list_labels or create them with gmail_create_label first.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Gmail message ID to label.',
        },
        labelIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of Gmail label IDs to add to the message (not names).',
        },
      },
      required: ['messageId', 'labelIds'],
    },
  },
  gmail_remove_label_from_email: {
    description:
      'Remove one or more Gmail labels from a specific message using label IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Gmail message ID to modify.',
        },
        labelIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of Gmail label IDs to remove from the message (not names).',
        },
      },
      required: ['messageId', 'labelIds'],
    },
  },
  gmail_list_thread_messages: {
    description:
      'List all messages in a Gmail thread. Use when the user wants to see or act on an entire conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'Gmail thread ID to list messages for.',
        },
      },
      required: ['threadId'],
    },
  },
  gmail_update_primary_signature: {
    description:
      'Update the signature for the user’s primary Gmail send-as address. Use when the user asks you to change their default email signature.',
    inputSchema: {
      type: 'object',
      properties: {
        signature: {
          type: 'string',
          description: 'New HTML or plain-text signature to set for the primary address.',
        },
      },
      required: ['signature'],
    },
  },
  gmail_list_send_as_aliases: {
    description:
      'List all Gmail send-as aliases for the user (addresses they can send from) including which is primary/default.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  gmail_get_send_as_alias: {
    description:
      'Get details for a specific Gmail send-as alias (e.g. a particular email address).',
    inputSchema: {
      type: 'object',
      properties: {
        sendAsEmail: {
          type: 'string',
          description: 'The exact email address of the send-as alias to fetch.',
        },
      },
      required: ['sendAsEmail'],
    },
  },
}

const CALENDAR_TOOLS: Record<string, { description: string; inputSchema: any }> = {
  calendar_create_event: {
    description:
      'Create a one-time Google Calendar event on the user’s primary calendar. Use when the user clearly gives you a title and time range.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Short title for the event (e.g. "Team meeting").',
        },
        startDateTime: {
          type: 'string',
          description: 'Event start date-time in ISO 8601 (e.g. "2026-01-28T15:00:00+01:00").',
        },
        endDateTime: {
          type: 'string',
          description: 'Event end date-time in ISO 8601. Must be after startDateTime.',
        },
        description: {
          type: 'string',
          description: 'Optional longer description / agenda for the event.',
        },
        location: {
          type: 'string',
          description: 'Optional event location.',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of attendee email addresses.',
        },
        reminderMinutes: {
          type: 'number',
          description:
            'Optional. Minutes before the event to show a reminder (e.g. 15 = 15 min before). Use for "remind me before" or reminder-style events.',
        },
      },
      required: ['summary', 'startDateTime', 'endDateTime'],
    },
  },
  calendar_list_events: {
    description:
      'List upcoming Google Calendar events for the user (primary calendar). Defaults to now through the next 30 days if no time range is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: {
          type: 'string',
          description:
            'Optional start of the time range in ISO 8601 (e.g. "2026-01-28T00:00:00+01:00"). Defaults to now.',
        },
        timeMax: {
          type: 'string',
          description:
            'Optional end of the time range in ISO 8601. Defaults to 30 days after timeMin.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of events to return (default 50, max 250).',
        },
        calendarId: {
          type: 'string',
          description: 'Optional calendar ID. Defaults to "primary".',
        },
      },
      required: [],
    },
  },
}

const CREATE_REMINDER_TOOL = {
  description:
    'Set a reminder so the user gets a WhatsApp message at that time. You have the user\'s timezone and current time; convert the time to dueAt as ISO 8601. The tool returns a factual result (e.g. "Reminder created. Due at X."). Reply to the user in your own words; do not parrot the tool result or say "reminder set".',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The exact message the user will receive when the reminder is delivered. Write it direct and natural. Good examples: "Don\'t forget to call John", "Time to submit the financial report", "Call the oil supplier today", "You\'re due to pick up the Jumia package."',
      },
      dueAt: { type: 'string', description: 'When to remind, ISO 8601 (e.g. "2026-01-28T15:00:00Z" or "2026-01-28T15:00:00+01:00"). Use user timezone.' },
      timezone: { type: 'string', description: 'Optional. IANA timezone for display. Omit to use the user\'s timezone.' },
    },
    required: ['content', 'dueAt'],
  },
}

/** Derive a short status from the first tool's description. Truncate at a full sentence or word boundary, not mid-word. Use generic text for connection tools so we don't send internal tool descriptions to the user. */
function getStatusForToolCalls(
  toolCalls: Array<{ toolName: string }>,
  tools: Record<string, { description?: string }>
): string {
  if (!toolCalls?.length) return 'Working on it...'
  const first = toolCalls[0]
  if (first?.toolName === 'search_connectable_apps') return 'Looking up your apps...'
  if (first?.toolName === 'send_connection_link') return 'Sending your connect link...'
  if (first?.toolName === 'create_reminder') return 'Setting a reminder...'
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

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN

  if (mode === 'subscribe' && token === verifyToken) {
    return new Response(challenge, { status: 200 })
  }

  return new Response('Forbidden', { status: 403 })
}

// POST - Receive messages
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Parse WhatsApp message
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    if (!message) {
      return NextResponse.json({ status: 'ok' })
    }

    // Use phone number directly from WhatsApp (they send valid numbers)
    const phoneNumber = message.from.trim()
    const incomingMessageId: string | undefined = typeof message.id === 'string' ? message.id : undefined

    // Resolve message text: from typed text or from voice message (download + transcribe)
    let messageText: string
    const isAudioMessage = message.type === 'audio' && message.audio?.id
    if (isAudioMessage) {
      const mediaId = message.audio.id as string
      if (incomingMessageId) {
        await sendTypingIndicator(incomingMessageId)
      }
      try {
        const { data } = await downloadWhatsAppMedia(mediaId)
        const MAX_AUDIO_BYTES = 25 * 1024 * 1024
        if (data.length > MAX_AUDIO_BYTES) {
          await sendWhatsAppMessage(
            phoneNumber,
            'Your voice message is too long. Please keep it under 2 minutes or send a text message.'
          )
          return NextResponse.json({ status: 'ok' })
        }
        const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const transcript = await transcribe({
          model: openai.transcription('gpt-4o-transcribe'),
          audio: data,
          abortSignal: AbortSignal.timeout(15000),
        })
        messageText = (transcript.text ?? '').trim()
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (error.name === 'AI_NoTranscriptGeneratedError') {
          console.error('[Voice] No transcript generated:', (err as { cause?: unknown }).cause)
        } else {
          console.error('[Voice] Transcribe or download failed:', error.message)
        }
        await sendWhatsAppMessage(
          phoneNumber,
          "I couldn't process your voice message. Please try again or type your message."
        )
        return NextResponse.json({ status: 'ok' })
      }
      if (!messageText) {
        await sendWhatsAppMessage(
          phoneNumber,
          "I couldn't make out what you said. Could you type it or try again in a short voice message?"
        )
        return NextResponse.json({ status: 'ok' })
      }
    } else {
      messageText = (message.text?.body ?? '').trim()
    }

    if (!messageText) {
      await sendWhatsAppMessage(phoneNumber, "Send a text or voice message and I'll help.")
      return NextResponse.json({ status: 'ok' })
    }

    // Validate message length (prevent DoS)
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
    
    // Initialize tools based on integration mode (Pipedream vs native)
    let mcpTools: Record<string, any> = {}
    let cleanupMCP: () => Promise<void> = async () => {}
    let connectedAppNames: string[] = []
    const pipedreamOn = isPipedreamEnabled()

    if (pipedreamOn) {
      // Pipedream mode: load MCP tools and use Pipedream connections as source of truth.
      try {
        const mcp = await initializePipedreamMCP(userId, phoneNumber)
        mcpTools = mcp.tools
        cleanupMCP = mcp.cleanup
        connectedAppNames = mcp.connectedAppNames
      } catch (mcpError) {
        const err = mcpError instanceof Error ? mcpError : new Error(String(mcpError))
        console.error('[AI] initializePipedreamMCP failed:', err.message)
        if (err.stack) console.error('[AI] MCP init stack:', err.stack)
        throw mcpError
      }
    } else {
      // Native mode: only our own Google connections (no Pipedream apps).
      try {
        const gmailConnection = await getAppConnection(userId, 'gmail')
        if (gmailConnection?.active) {
          connectedAppNames.push('gmail')
        }
      } catch {
        // Non-fatal; if this fails we simply won't list Gmail as connected in the prompt.
      }
    }

    const toolsForAi = pipedreamOn
      ? {
          ...mcpTools,
          search_connectable_apps: SEARCH_CONNECTABLE_APPS_TOOL,
          send_connection_link: SEND_CONNECTION_LINK_TOOL,
          create_reminder: CREATE_REMINDER_TOOL,
        }
      : {
          ...GMAIL_TOOLS,
          ...CALENDAR_TOOLS,
          send_connection_link: SEND_CONNECTION_LINK_TOOL,
          create_reminder: CREATE_REMINDER_TOOL,
        }

    const userTimeContext = getTimezoneFromPhone(phoneNumber)

    let memoryContext = ''
    let memoriesFromRecall: MemoryItem[] = []
    let recalledIds: string[] = []
    if (process.env.MEMORY_ENABLED === 'true') {
      try {
        const mem = await getMemoriesForTurn(userId, messageText, { tokenBudget: 800 })
        memoryContext = mem.memoryContext
        memoriesFromRecall = mem.memories
        recalledIds = mem.recalledIds
      } catch (_) {
        memoryContext = ''
        memoriesFromRecall = []
        recalledIds = []
      }
    }

    try {
      // Multi-round tool loop: we run tools in the webhook (not in SDK execute) and re-call
      // processUserMessage until we get a text response. Aligned with Vercel AI SDK "forward
      // tool calls to client/queue" pattern; see lib/ai/TOOL_LOOP_AND_VERCEL_DOCS.md
      const MAX_TOOL_ROUNDS = 3
      let aiResult = await processUserMessage(
        messageText,
        userId,
        messageHistory,
        userName,
        toolsForAi,
        phoneNumber,
        connectedAppNames,
        userTimeContext.timezone,
        userTimeContext.country,
        memoryContext
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

        // const statusMessage = getStatusForToolCalls(aiResult.toolCalls, toolsForAi)
        await sendWhatsAppMessage(phoneNumber, `🔄 Working on it...`)


        const hasSearchInRound = aiResult.toolCalls.some(
          (t: { toolName: string }) => t.toolName === 'search_connectable_apps'
        )
        for (const toolCall of aiResult.toolCalls) {
          try {
            let toolResultText: string
            if (toolCall.toolName === 'search_connectable_apps') {
              const query = (toolCall.args?.query ?? '').toString().trim()
              const result = await searchConnectableApps(query)
              toolResultText = JSON.stringify(result)
            } else if (toolCall.toolName === 'send_connection_link') {
              if (hasSearchInRound) {
                toolResultText =
                  'You called send_connection_link in the same round as search_connectable_apps. Use the search result above: pick one app from the "apps" list that matches what the user asked for, then in your next message call send_connection_link with that app\'s exact "slug" value. Do not guess a slug.'
              } else {
                const appSlug = (toolCall.args?.appSlug ?? '').toString().trim()
                const linkResult = await createAndSendConnectLink(phoneNumber, appSlug)
                toolResultText = linkResult.success
                  ? `Connection link sent to the user on WhatsApp.`
                  : `Failed: ${linkResult.error ?? 'Unknown error'}`
              }
            } else if (toolCall.toolName === 'create_reminder') {
              const content = (toolCall.args?.content ?? '').toString().trim()
              const dueAt = (toolCall.args?.dueAt ?? '').toString().trim()
              const timezone = (toolCall.args?.timezone ?? userTimeContext.timezone ?? 'UTC').toString().trim()
              const reminderResult = await createReminder({
                userId,
                content,
                dueAt,
                timezone: timezone || userTimeContext.timezone || 'UTC',
              })
              toolResultText = reminderResult.success
                ? reminderResult.message
                : `Failed: ${reminderResult.error}`
            } else if (toolCall.toolName === 'gmail_send_email') {
              const to = (toolCall.args?.to ?? '').toString().trim()
              const subject = (toolCall.args?.subject ?? '').toString().trim()
              const body = (toolCall.args?.body ?? '').toString().trim()
              const cc = (toolCall.args?.cc ?? '').toString().trim()
              const bcc = (toolCall.args?.bcc ?? '').toString().trim()
              if (!to || !subject || !body) {
                toolResultText =
                  'Missing required fields for gmail_send_email. Required: to, subject, body.'
              } else {
                const result = await sendEmail(userId, {
                  to,
                  subject,
                  body,
                  ...(cc && { cc }),
                  ...(bcc && { bcc }),
                })
                toolResultText = result.error
                  ? result.error
                  : `Email sent. Message ID: ${result.id ?? 'unknown'}.`
              }
            } else if (toolCall.toolName === 'gmail_create_draft') {
              const to = (toolCall.args?.to ?? '').toString().trim()
              const subject = (toolCall.args?.subject ?? '').toString().trim()
              const body = (toolCall.args?.body ?? '').toString().trim()
              const cc = (toolCall.args?.cc ?? '').toString().trim()
              const bcc = (toolCall.args?.bcc ?? '').toString().trim()
              if (!to || !subject || !body) {
                toolResultText =
                  'Missing required fields for gmail_create_draft. Required: to, subject, body.'
              } else {
                const result = await createDraft(userId, {
                  to,
                  subject,
                  body,
                  ...(cc && { cc }),
                  ...(bcc && { bcc }),
                })
                toolResultText = result.error
                  ? result.error
                  : `Draft created. Draft ID: ${result.id ?? 'unknown'}.`
              }
            } else if (toolCall.toolName === 'gmail_find_email') {
              const query = (toolCall.args?.query ?? '').toString().trim()
              const maxResultsRaw = toolCall.args?.maxResults
              const maxResults =
                typeof maxResultsRaw === 'number'
                  ? maxResultsRaw
                  : Number.parseInt((maxResultsRaw ?? '').toString(), 10) || 20
              if (!query) {
                toolResultText = 'Missing required field "query" for gmail_find_email.'
              } else {
                const result = await listMessages(userId, {
                  q: query,
                  maxResults,
                })
                toolResultText = result.error
                  ? result.error
                  : JSON.stringify({
                      messages: result.messages ?? [],
                      nextPageToken: result.nextPageToken ?? null,
                    })
              }
            } else if (toolCall.toolName === 'gmail_list_labels') {
              const result = await listLabels(userId)
              toolResultText = result.error
                ? result.error
                : JSON.stringify({ labels: result.labels ?? [] })
            } else if (toolCall.toolName === 'gmail_create_label') {
              const name = (toolCall.args?.name ?? '').toString().trim()
              if (!name) {
                toolResultText = 'Missing required field "name" for gmail_create_label.'
              } else {
                const result = await createLabel(userId, name)
                toolResultText = result.error
                  ? result.error
                  : JSON.stringify({ label: result.label })
              }
            } else if (toolCall.toolName === 'gmail_archive_email') {
              const messageId = (toolCall.args?.messageId ?? '').toString().trim()
              if (!messageId) {
                toolResultText =
                  'Missing required field "messageId" for gmail_archive_email.'
              } else {
                const result = await archiveMessage(userId, messageId)
                toolResultText = result.error
                  ? result.error
                  : `Message archived: ${messageId}.`
              }
            } else if (toolCall.toolName === 'gmail_delete_email') {
              const messageId = (toolCall.args?.messageId ?? '').toString().trim()
              if (!messageId) {
                toolResultText =
                  'Missing required field "messageId" for gmail_delete_email.'
              } else {
                const result = await deleteMessage(userId, messageId)
                toolResultText = result.error
                  ? result.error
                  : `Message deleted: ${messageId}.`
              }
            } else if (toolCall.toolName === 'gmail_add_label_to_email') {
              const messageId = (toolCall.args?.messageId ?? '').toString().trim()
              const labelIds = Array.isArray(toolCall.args?.labelIds)
                ? (toolCall.args.labelIds as unknown[])
                    .map((v) => v?.toString().trim())
                    .filter((v) => !!v)
                : []
              if (!messageId || labelIds.length === 0) {
                toolResultText =
                  'Missing required fields for gmail_add_label_to_email. Required: messageId, labelIds[].'
              } else {
                const result = await addLabelsToMessage(
                  userId,
                  messageId,
                  labelIds as string[]
                )
                toolResultText = result.error
                  ? result.error
                  : `Labels added to message ${messageId}.`
              }
            } else if (toolCall.toolName === 'gmail_remove_label_from_email') {
              const messageId = (toolCall.args?.messageId ?? '').toString().trim()
              const labelIds = Array.isArray(toolCall.args?.labelIds)
                ? (toolCall.args.labelIds as unknown[])
                    .map((v) => v?.toString().trim())
                    .filter((v) => !!v)
                : []
              if (!messageId || labelIds.length === 0) {
                toolResultText =
                  'Missing required fields for gmail_remove_label_from_email. Required: messageId, labelIds[].'
              } else {
                const result = await removeLabelsFromMessage(
                  userId,
                  messageId,
                  labelIds as string[]
                )
                toolResultText = result.error
                  ? result.error
                  : `Labels removed from message ${messageId}.`
              }
            } else if (toolCall.toolName === 'gmail_list_thread_messages') {
              const threadId = (toolCall.args?.threadId ?? '').toString().trim()
              if (!threadId) {
                toolResultText =
                  'Missing required field "threadId" for gmail_list_thread_messages.'
              } else {
                const result = await listThreadMessages(userId, threadId)
                toolResultText = result.error
                  ? result.error
                  : JSON.stringify({ messages: result.messages ?? [] })
              }
            } else if (toolCall.toolName === 'gmail_update_primary_signature') {
              const signature = (toolCall.args?.signature ?? '').toString()
              if (!signature.trim()) {
                toolResultText =
                  'Missing required field "signature" for gmail_update_primary_signature.'
              } else {
                const result = await updatePrimarySignature(userId, signature)
                toolResultText = result.error
                  ? result.error
                  : `Primary Gmail signature updated for ${result.alias?.sendAsEmail ?? 'primary address'}.`
              }
            } else if (toolCall.toolName === 'gmail_list_send_as_aliases') {
              const result = await listSendAsAliases(userId)
              toolResultText = result.error
                ? result.error
                : JSON.stringify({ aliases: result.aliases ?? [] })
            } else if (toolCall.toolName === 'gmail_get_send_as_alias') {
              const sendAsEmail = (toolCall.args?.sendAsEmail ?? '').toString().trim()
              if (!sendAsEmail) {
                toolResultText =
                  'Missing required field "sendAsEmail" for gmail_get_send_as_alias.'
              } else {
                const result = await getSendAsAlias(userId, sendAsEmail)
                toolResultText = result.error
                  ? result.error
                  : JSON.stringify({ alias: result.alias })
              }
            } else if (toolCall.toolName === 'calendar_create_event') {
              const summary = (toolCall.args?.summary ?? '').toString().trim()
              const startDateTime = (toolCall.args?.startDateTime ?? '').toString().trim()
              const endDateTime = (toolCall.args?.endDateTime ?? '').toString().trim()
              const description = (toolCall.args?.description ?? '').toString().trim()
              const location = (toolCall.args?.location ?? '').toString().trim()
              const attendeesRaw = toolCall.args?.attendees
              const attendees =
                Array.isArray(attendeesRaw)
                  ? (attendeesRaw as unknown[])
                      .map((v) => v?.toString().trim())
                      .filter((v) => !!v)
                  : []
              const reminderMinutesRaw = toolCall.args?.reminderMinutes
              const reminderMinutes =
                typeof reminderMinutesRaw === 'number' && reminderMinutesRaw >= 0
                  ? reminderMinutesRaw
                  : undefined
              if (!summary || !startDateTime || !endDateTime) {
                toolResultText =
                  'Missing required fields for calendar_create_event. Required: summary, startDateTime, endDateTime.'
              } else {
                const result = await createCalendarEvent(userId, {
                  summary,
                  startDateTime,
                  endDateTime,
                  ...(description && { description }),
                  ...(location && { location }),
                  ...(attendees.length > 0 && { attendees: attendees as string[] }),
                  ...(reminderMinutes != null && { reminderMinutes }),
                })
                toolResultText = result.error
                  ? result.error
                  : `Calendar event created${result.htmlLink ? `: ${result.htmlLink}` : '.'}`
              }
            } else if (toolCall.toolName === 'calendar_list_events') {
              const timeMin = (toolCall.args?.timeMin ?? '').toString().trim() || undefined
              const timeMax = (toolCall.args?.timeMax ?? '').toString().trim() || undefined
              const maxResultsRaw = toolCall.args?.maxResults
              const maxResults =
                typeof maxResultsRaw === 'number'
                  ? maxResultsRaw
                  : maxResultsRaw
                  ? Number.parseInt(maxResultsRaw.toString(), 10) || undefined
                  : undefined
              const calendarId = (toolCall.args?.calendarId ?? '').toString().trim() || undefined
              const result = await listCalendarEvents(userId, {
                timeMin,
                timeMax,
                maxResults,
                calendarId,
              })
              toolResultText = result.error
                ? result.error
                : JSON.stringify({ events: result.events ?? [] })
            } else {
              const toolDef = mcpTools[toolCall.toolName]
              const appName = toolDef?.appName
              const args = toolCall.args ?? {}
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
              } else if (isCalendarCreateEventTool(toolCall.toolName, appName)) {
                const instruction = (typeof args.instruction === 'string' ? args.instruction : typeof (args as { input?: string }).input === 'string' ? (args as { input: string }).input : '').trim()
                const extracted = instruction
                  ? await extractCalendarEventFromInstruction(instruction, {
                      timezone: userTimeContext.timezone,
                      country: userTimeContext.country,
                    })
                  : null
                if (extracted && !extracted.isRecurring) {
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
                    const eventId = r && typeof r === 'object' && 'id' in r ? (r as { id: string }).id : undefined
                    waitUntil(
                      createCalendarNudgeReminders({
                        userId,
                        timezone: userTimeContext.timezone,
                        summary: extracted.summary,
                        startDateTimeIso: extracted.startDateTime,
                        externalEventId: eventId,
                      })
                    )
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
                const toolResult = await executePipedreamTool(
                  userId,
                  phoneNumber,
                  toolCall.toolName,
                  toolCall.args ?? {},
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
        // Use same connectedAppNames from MCP so we never list an app we don't have tools for (toolsForAi is unchanged this request)
        aiResult = await processUserMessage(
          messageText,
          userId,
          updatedMessageHistory,
          userName,
          toolsForAi,
          phoneNumber,
          connectedAppNames,
          userTimeContext.timezone,
          userTimeContext.country,
          memoryContext
        )
      }

      if (aiResult && aiResult.response && aiResult.response.trim()) {
        const savedAssistant = await saveAssistantMessage(
          conversation.id,
          aiResult.response,
          aiResult.toolCalls
        )
        await sendWhatsAppMessage(phoneNumber, aiResult.response)
        if (process.env.MEMORY_ENABLED === 'true') {
          waitUntil(
            retain({
              userId,
              userMessage: messageText,
              assistantMessage: aiResult.response,
              lastMessageId: savedAssistant?.id ?? null,
              memoriesFromRecall,
            })
          )
          if (recalledIds.length > 0) {
            waitUntil(markRecalled(userId, recalledIds))
          }
        }
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
