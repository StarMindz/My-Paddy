import { getPipedreamClient } from '@/lib/mcp/pipedream-auth'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

/** Normalize to URL-safe slug: lowercase, spaces to underscores, alphanumeric + underscore only. */
function toSlug(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

/**
 * Resolve app name to slug using Pipedream List Apps API. One call, no hardcoding:
 * getApps(q), prefer app where name_slug === toSlug(appName), else first result.
 */
async function resolveSlug(appName: string): Promise<{ slug: string; displayName: string }> {
  const trimmed = (appName || '').trim()
  const wantSlug = toSlug(trimmed)
  try {
    const client = getPipedreamClient()
    const res = await client.getApps({ q: trimmed || wantSlug, limit: 15 })
    const apps = res?.data ?? []
    if (apps.length > 0 && wantSlug) {
      const match = apps.find(
        (a: { name_slug?: string }) => (a.name_slug || '').toLowerCase() === wantSlug
      )
      if (match?.name_slug) {
        return { slug: match.name_slug, displayName: match.name || match.name_slug }
      }
    }
    const first = apps[0]
    if (first?.name_slug) {
      return { slug: first.name_slug, displayName: first.name || first.name_slug }
    }
  } catch {
    // fall through to normalized slug
  }
  const slug = wantSlug || 'gmail'
  return { slug, displayName: trimmed || slug }
}

/**
 * Create a Pipedream Connect Link and send it to the user via WhatsApp.
 * Resolves app name via List Apps (one API call, prefer exact slug match). No hardcoding.
 */
export async function createAndSendConnectLink(
  phoneNumber: string,
  appName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { slug, displayName } = await resolveSlug(appName)

    const pipedreamClient = getPipedreamClient()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
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
