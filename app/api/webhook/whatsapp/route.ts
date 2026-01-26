import { NextRequest, NextResponse } from 'next/server'
import { getUserByPhone } from '@/lib/db/users'
import { getSignupState, setSignupState, clearSignupState } from '@/lib/db/signup-states'
import { createUser } from '@/lib/db/users'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

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

    const phoneNumber = message.from
    const messageText = message.text?.body || ''

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
        // Validate email
        if (isValidEmail(messageText)) {
          await setSignupState(phoneNumber, 'name', { email: messageText })
          await sendWhatsAppMessage(
            phoneNumber,
            'Perfect! What\'s your name?'
          )
          return NextResponse.json({ status: 'ok' })
        } else {
          await sendWhatsAppMessage(
            phoneNumber,
            'That doesn\'t look like a valid email address. Please try again:\n\n' +
            'Example: yourname@example.com'
          )
          return NextResponse.json({ status: 'ok' })
        }
      }

      if (signupState.step === 'name') {
        // Create user
        const userName = messageText.trim()
        if (!userName || userName.length < 2) {
          await sendWhatsAppMessage(
            phoneNumber,
            'Please provide a valid name (at least 2 characters).'
          )
          return NextResponse.json({ status: 'ok' })
        }

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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
