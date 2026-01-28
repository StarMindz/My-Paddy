import { NextRequest, NextResponse } from 'next/server'
import { getPipedreamClient } from '@/lib/mcp/pipedream-auth'
import { getUserByPhone } from '@/lib/db/users'
import { getPrismaClient } from '@/lib/db/client'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

/**
 * Generate Connect Link for WhatsApp users to connect their apps
 * 
 * Flow:
 * 1. User sends message like "connect gmail" or "connect my calendar"
 * 2. This endpoint generates a Connect Link URL
 * 3. Send URL to user via WhatsApp
 * 4. User clicks link, completes OAuth on Pipedream
 * 5. Pipedream webhook (if configured) notifies us, or we poll for connection
 * 
 * POST /api/connect/link
 * Body: { phoneNumber: string, appName: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { phoneNumber, appName } = body

    if (!phoneNumber || !appName) {
      return NextResponse.json(
        { error: 'phoneNumber and appName are required' },
        { status: 400 }
      )
    }

    // Initialize Pipedream client
    const pipedreamClient = getPipedreamClient()

    // Generate Connect token using phone number directly as externalUserId
    // Pipedream accepts ANY string as externalUserId - phone numbers work perfectly!
    const tokenResponse = await pipedreamClient.createConnectToken({
      external_user_id: phoneNumber, // Use phone number directly
    })

    // Build Connect Link URL with app parameter
    // Format: https://pipedream.com/_static/connect.html?token={token}&connectLink=true&app={appName}
    const connectLink = `${tokenResponse.connect_link_url}&app=${encodeURIComponent(appName)}`

    // Send link to user via WhatsApp
    await sendWhatsAppMessage(
      phoneNumber,
      `🔗 Connect your ${appName} account:\n\n${connectLink}\n\n` +
      `Click this link to securely connect your account. The link expires in 4 hours.`
    )

    return NextResponse.json({
      success: true,
      connectLink,
      message: 'Connect link sent to user'
    })
  } catch (error) {
    console.error('[Connect] Error generating link:', error)
    return NextResponse.json(
      { error: 'Failed to generate connect link' },
      { status: 500 }
    )
  }
}

/**
 * Handle webhook from Pipedream when user connects an account
 * Configure this URL in Pipedream project settings: PUT /api/connect/link
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Pipedream webhook payload structure:
    // { external_user_id, account_id, app, status, ... }
    const { external_user_id, account_id, app, status } = body

    if (!external_user_id || !account_id || !app) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // external_user_id is the phone number (we use phone numbers directly)
    const phoneNumber = external_user_id

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
      // Create or update app connection using phone number as userId
      await prisma.appConnection.upsert({
        where: {
          userId_appName: {
            userId: user.id, // Use user.id for database, but phoneNumber for Pipedream
            appName: app
          }
        },
        update: {
          pipedreamConnectionId: account_id, // This is apn_xxxxxxx
          active: true,
          connectedAt: new Date()
        },
        create: {
          userId: user.id,
          appName: app,
          pipedreamConnectionId: account_id,
          active: true
        }
      })

      // Send confirmation via WhatsApp
      await sendWhatsAppMessage(
        phoneNumber,
        `✅ Successfully connected your ${app} account! You can now use features like creating events, sending emails, and more.`
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
  } catch (error) {
    console.error('[Connect] Error handling webhook:', error)
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    )
  }
}
