import { NextRequest, NextResponse } from 'next/server'
import { getGoogleAuthUrl } from '@/lib/google/oauth'

/**
 * GET /api/connect/google?state=PHONE_NUMBER
 * Redirects the user to Google OAuth for Gmail. state must be the user's phone number
 * so we can associate the token on callback.
 */
export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get('state')
  if (!state || !state.trim()) {
    return NextResponse.json(
      { error: 'Missing state (phone number) parameter' },
      { status: 400 }
    )
  }
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_APP_URL or VERCEL_URL must be set' },
      { status: 500 }
    )
  }
  const redirectUri = `${baseUrl}/api/connect/google/callback`
  try {
    const url = getGoogleAuthUrl(redirectUri, state.trim())
    return NextResponse.redirect(url)
  } catch (error) {
    console.error('[Connect Google] Error building auth URL:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start Google sign-in' },
      { status: 500 }
    )
  }
}
