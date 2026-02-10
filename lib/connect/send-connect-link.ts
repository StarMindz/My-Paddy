import { getPipedreamClient } from '@/lib/mcp/pipedream-auth'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

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
 * Create a Pipedream Connect Link and send it to the user via WhatsApp.
 * Expects a concrete app slug (e.g. "gmail", "google-calendar") chosen from
 * real Pipedream apps (e.g. via searchConnectableApps). No slug guessing here.
 */
export async function createAndSendConnectLink(
  phoneNumber: string,
  appSlug: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const slug = (appSlug || '').trim() || 'gmail'
    const displayName = slug

    const pipedreamClient = getPipedreamClient()
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    const webhookUri = baseUrl ? `${baseUrl}/api/connect/link` : undefined
    const tokenResponse = await pipedreamClient.createConnectToken({
      external_user_id: phoneNumber,
      ...(webhookUri && { webhook_uri: webhookUri }),
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
