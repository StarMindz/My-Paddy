import { NextRequest, NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/db/client'
import { getUserByPhone } from '@/lib/db/users'
import { exchangeCodeForTokens } from '@/lib/google/oauth'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

const GOOGLE_CALENDAR_APP_NAME = 'google_calendar'

/**
 * GET /api/connect/google-calendar/callback?code=...&state=PHONE_NUMBER
 * Google redirects here after user authorizes. Exchange code for tokens and store for Google Calendar.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state?.trim()) {
    return NextResponse.json(
      { error: 'Missing code or state' },
      { status: 400 }
    )
  }
  const phoneNumber = state.trim()
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_APP_URL or VERCEL_URL must be set' },
      { status: 500 }
    )
  }
  const redirectUri = `${baseUrl}/api/connect/google-calendar/callback`
  let tokens
  try {
    tokens = await exchangeCodeForTokens(code, redirectUri)
  } catch (error) {
    console.error('[Connect Google Calendar] Token exchange failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to complete sign-in' },
      { status: 500 }
    )
  }
  if (!tokens.refresh_token) {
    return NextResponse.json(
      { error: 'Google did not return a refresh token (user may have already authorized)' },
      { status: 400 }
    )
  }
  const user = await getUserByPhone(phoneNumber)
  if (!user) {
    return NextResponse.json(
      { error: 'User not found. Please start a conversation with My Padi first.' },
      { status: 404 }
    )
  }
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000)
  const prisma = getPrismaClient() as any
  await prisma.appConnection.upsert({
    where: {
      userId_appName: { userId: user.id, appName: GOOGLE_CALENDAR_APP_NAME },
    },
    update: {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      tokenExpiresAt: expiresAt,
      pipedreamConnectionId: null,
      active: true,
      connectedAt: new Date(),
    },
    create: {
      userId: user.id,
      appName: GOOGLE_CALENDAR_APP_NAME,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      tokenExpiresAt: expiresAt,
      active: true,
    },
  })
  try {
    await sendWhatsAppMessage(
      phoneNumber,
      '✅ Google Calendar connected successfully. You can now create and view events from here.'
    )
  } catch (_) {
    // Best-effort; user still connected
  }
  return NextResponse.redirect(`${baseUrl}/api/connect/google/success`)
}

