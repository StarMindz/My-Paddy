import { getPipedreamClient } from '@/lib/mcp/pipedream-auth'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'
import { getGoogleAuthUrl, getGoogleCalendarAuthUrl } from '@/lib/google/oauth'
import { isPipedreamEnabled } from '@/lib/config/integrations'

/**
 * Search Pipedream Connect apps by query.
 * Thin wrapper around Pipedream's List Apps / App Discovery so the model can
 * choose from **real** apps (by slug) instead of us guessing.
 */
export async function searchConnectableApps(
  query: string
): Promise<{ apps: Array<{ slug: string; name: string; description?: string }> }> {
  const trimmed = (query || '').trim()
  const client = getPipedreamClient()
  const res = await client.getApps({ q: trimmed || undefined, limit: 15 })
  const apps = res?.data ?? []
  return {
    apps: apps
      .filter((a: { name_slug?: string }) => !!a.name_slug)
      .map((a: { name_slug: string; name?: string; description?: string }) => ({
        slug: a.name_slug,
        name: a.name || a.name_slug,
        description: a.description,
      })),
  }
}

/**
 * Create a Connect Link and send it to the user via WhatsApp.
 *
 * - When Pipedream is enabled (PIPEDREAM_STATE === 'true'), this always creates
 *   a Pipedream Connect link for the requested app slug.
 * - When Pipedream is disabled, Gmail uses our native Google OAuth flow instead
 *   so we can rely on our own tokens and tools.
 */
export async function createAndSendConnectLink(
  phoneNumber: string,
  appSlug: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const slug = (appSlug || '').trim() || 'gmail'
    const displayName = slug
    const pipedreamOn = isPipedreamEnabled()
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    if (!baseUrl) {
      throw new Error('NEXT_PUBLIC_APP_URL or VERCEL_URL must be set')
    }

    // Native Gmail OAuth when Pipedream is disabled.
    if (!pipedreamOn && slug === 'gmail') {
      const redirectUri = `${baseUrl}/api/connect/google/callback`
      const authUrl = getGoogleAuthUrl(redirectUri, phoneNumber)
      await sendWhatsAppMessage(
        phoneNumber,
        `🔗 Connect your Gmail account:\n\n${authUrl}\n\n` +
          `Tap this link to securely connect your Gmail. Once you're done, come back here and tell me what you want to do (e.g. "send an email to ...").`
      )
      return { success: true }
    }

    // Native Google Calendar OAuth when Pipedream is disabled.
    if (!pipedreamOn && slug === 'google-calendar') {
      const redirectUri = `${baseUrl}/api/connect/google-calendar/callback`
      const authUrl = getGoogleCalendarAuthUrl(redirectUri, phoneNumber)
      await sendWhatsAppMessage(
        phoneNumber,
        `🔗 Connect your Google Calendar:\n\n${authUrl}\n\n` +
          `Tap this link to securely connect your Google Calendar. Once you're done, come back here and tell me what you want to do (e.g. "create an event for tomorrow at 3pm").`
      )
      return { success: true }
    }

    // Default: Pipedream Connect link (all apps when enabled, and Gmail when in Pipedream mode).
    const pipedreamClient = getPipedreamClient()
    const webhookUri = `${baseUrl}/api/connect/link`
    const tokenResponse = await pipedreamClient.createConnectToken({
      external_user_id: phoneNumber,
      webhook_uri: webhookUri,
    } as { external_user_id: string; webhook_uri?: string })
    const connectLink = `${tokenResponse.connect_link_url}&app=${encodeURIComponent(slug)}`
    await sendWhatsAppMessage(
      phoneNumber,
      `🔗 Connect your ${displayName} account:\n\n${connectLink}\n\n` +
        `Click this link to securely connect. The link expires in 4 hours.`
    )
    return { success: true }
  } catch (error) {
    console.error('[Connect] Error creating/sending link:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send connection link',
    }
  }
}
