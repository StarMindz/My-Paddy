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
import { z } from 'zod'

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
    // Use phone number as externalUserId (Pipedream accepts any string!)
    const { tools: mcpTools, cleanup: cleanupMCP } = await initializePipedreamMCP(userId, phoneNumber)
    
    try {
      // Process with AI (includes conversation history and tools)
      let aiResult = await processUserMessage(
        messageText,
        userId,
        messageHistory,
        userName,
        mcpTools,
        phoneNumber // Pass phone number for Pipedream externalUserId
      )
      
      // Handle tool calls if any
      if (aiResult && aiResult.toolCalls && aiResult.toolCalls.length > 0) {
        // Send status update for tool execution
        await sendWhatsAppMessage(phoneNumber, '🔄 Working on it...')
        
        // Execute each tool call
        const toolResults: Array<{ toolCallId: string; toolName: string; result: string }> = []
        
        for (const toolCall of aiResult.toolCalls) {
          try {
            // Get appName from tool definition (stored when tools were retrieved)
            const toolDef = mcpTools[toolCall.toolName]
            const appName = toolDef?.appName
            
            // Execute tool via MCP
            // Use phone number as externalUserId for Pipedream
            const toolResult = await executePipedreamTool(
              userId,
              phoneNumber,
              toolCall.toolName,
              toolCall.args,
              appName
            )
            
            // Save tool result to database
            await saveToolMessage(
              conversation.id,
              toolCall.toolCallId,
              toolCall.toolName,
              toolResult.error || toolResult.result || 'Tool executed'
            )
            
            toolResults.push({
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              result: toolResult.error || toolResult.result || 'Tool executed'
            })
          } catch (error) {
            console.error(`[AI] Error executing tool ${toolCall.toolName}:`, error)
            await saveToolMessage(
              conversation.id,
              toolCall.toolCallId,
              toolCall.toolName,
              `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            )
          }
        }
        
        // Get updated conversation history with tool results
        const updatedHistory = await getConversationWithMessages(userId, 20)
        const updatedMessageHistory = updatedHistory?.messages || []
        
        // Process again with tool results to get final response
        aiResult = await processUserMessage(
          messageText,
          userId,
          updatedMessageHistory,
          userName,
          mcpTools,
          phoneNumber // Pass phone number for Pipedream externalUserId
        )
      }
      
      if (aiResult && aiResult.response) {
        // Save assistant response to database
        await saveAssistantMessage(
          conversation.id,
          aiResult.response,
          aiResult.toolCalls
        )
        
        // Send response to WhatsApp
        await sendWhatsAppMessage(phoneNumber, aiResult.response)
      } else {
        // Fallback if AI fails
        await sendWhatsAppMessage(
          phoneNumber,
          'Sorry, I encountered an error processing your message. Please try again.'
        )
      }
    } finally {
      // Cleanup MCP connections
      await cleanupMCP()
    }
  } catch (error) {
    console.error('[AI] Error processing message:', error)
    await sendWhatsAppMessage(
      phoneNumber,
      'Sorry, I encountered an error processing your message. Please try again.'
    )
  }
}
