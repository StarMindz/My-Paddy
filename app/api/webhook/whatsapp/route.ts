import { NextRequest, NextResponse } from 'next/server'
import { getUserByPhone } from '@/lib/db/users'
import { getSignupState, setSignupState, clearSignupState } from '@/lib/db/signup-states'
import { createUser } from '@/lib/db/users'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'
import { extractSignupData } from '@/lib/ai/extract-signup-data'
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

    // Validate phone number format (E.164: +[country code][number])
    const phoneNumberSchema = z.string().regex(/^\+[1-9]\d{1,14}$/)
    const phoneNumberResult = phoneNumberSchema.safeParse(message.from)
    if (!phoneNumberResult.success) {
      console.warn('[Security] Invalid phone number format')
      return NextResponse.json({ status: 'ok' })
    }
    const phoneNumber = phoneNumberResult.data

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

    // Existing user - process message
    if (user) {
      // TODO: Send to AI with tools
      // For now, send acknowledgment
      await sendWhatsAppMessage(
        phoneNumber,
        'I received your message. AI processing coming soon!'
      )
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
