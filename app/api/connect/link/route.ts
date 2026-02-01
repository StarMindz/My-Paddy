import { NextRequest, NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/db/client'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'
import { createAndSendConnectLink } from '@/lib/connect/send-connect-link'

/**
 * Handle webhook from Pipedream when user connects an account
 * Pipedream sends POST to the webhook_uri you pass when creating the Connect token (no UI setting).
 * Payload: { event: "CONNECTION_SUCCESS"|"CONNECTION_ERROR", account: { id, external_id, app: { name_slug } } }
 */
async function handleConnectionWebhook(body: any): Promise<NextResponse> {
  // Pipedream format: event + account.id, account.external_id, account.app.name_slug
  const event = body.event
  const account = body.account
  const phoneNumber = account?.external_id ?? body.external_user_id
  const accountId = account?.id ?? body.account_id
  const app = account?.app?.name_slug ?? body.app
  const status = event === 'CONNECTION_SUCCESS' ? 'connected' : event === 'CONNECTION_ERROR' ? 'error' : body.status

  if (!phoneNumber || !accountId || !app) {
    console.error('[Connect Webhook] Missing required fields')
    return NextResponse.json(
      { error: 'Missing required fields (account.external_id, account.id, account.app.name_slug or legacy fields)' },
      { status: 400 }
    )
  }

    const prisma = getPrismaClient() as any

    // Get or create user by phone number
    let user = await prisma.user.findUnique({
      where: { phoneNumber: phoneNumber }
    })

    if (!user) {
      // Create user if doesn't exist (shouldn't happen, but handle it)
      user = await prisma.user.create({
        data: {
          phoneNumber: phoneNumber,
          email: '', // Will be set during signup
          name: null
        }
      })
    }

    if (status === 'connected') {
      await prisma.appConnection.upsert({
        where: {
          userId_appName: {
            userId: user.id,
            appName: app
          }
        },
        update: {
          pipedreamConnectionId: accountId,
          active: true,
          connectedAt: new Date()
        },
        create: {
          userId: user.id,
          appName: app,
          pipedreamConnectionId: accountId,
          active: true
        }
      })

      // Send confirmation via WhatsApp
      await sendWhatsAppMessage(
        phoneNumber,
        `✅ Successfully connected your ${app} account! You can now use access tools needed to complete your request.`
      )
    } else if (status === 'disconnected') {
      // Mark connection as inactive
      await prisma.appConnection.updateMany({
        where: {
          userId: user.id,
          appName: app
        },
        data: {
          active: false
        }
      })
    }

    return NextResponse.json({ success: true })
}

/** Pipedream sends POST to webhook_uri when user completes connection. */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    return await handleConnectionWebhook(body)
  } catch (error) {
    console.error('[Connect] Error handling webhook:', error)
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/connect/link – two uses:
 * 1. Our app: Body { phoneNumber, appName } → create Connect link and send to user.
 * 2. Pipedream webhook: Body { event, account } → handle connection success/error (webhook_uri is set when creating the token).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    if (body.event && body.account) {
      return await handleConnectionWebhook(body)
    }
    const { phoneNumber, appName } = body
    if (!phoneNumber || !appName) {
      return NextResponse.json(
        { error: 'phoneNumber and appName are required, or Pipedream webhook payload (event + account)' },
        { status: 400 }
      )
    }
    const result = await createAndSendConnectLink(phoneNumber, appName)
    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? 'Failed to generate connect link' },
        { status: 500 }
      )
    }
    return NextResponse.json({ success: true, message: 'Connect link sent to user' })
  } catch (error) {
    console.error('[Connect] Error:', error)
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    )
  }
}
