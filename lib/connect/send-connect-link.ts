import { getPipedreamClient } from '@/lib/mcp/pipedream-auth'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

/**
 * Resolve an app name (natural language or slug) to the official Pipedream app slug.
 * Uses Pipedream Connect "List apps" API: https://pipedream.com/docs/connect/api-reference/list-apps
 * Returns { slug, displayName } or null if not found.
 */
export async function resolveAppSlug(
  appName: string
): Promise<{ slug: string; displayName: string } | null> {
  const trimmed = (appName || '').trim()
  if (!trimmed) return null
  try {
    const client = getPipedreamClient()
    const res = await client.getApps({ q: trimmed, limit: 10 })
    const first = res?.data?.[0]
    if (first?.name_slug) {
      return { slug: first.name_slug, displayName: first.name || first.name_slug }
    }
  } catch {
    // Fall back to using input as slug
  }
  return null
}

/**
 * Resolve app name to slug for the connect URL. Uses List Apps API when possible;
 * otherwise normalizes input (e.g. "Google Docs" -> "google_docs") for URL.
 */
export async function getAppSlugForConnect(appName: string): Promise<{ slug: string; displayName: string }> {
  const resolved = await resolveAppSlug(appName)
  if (resolved) return resolved
  const normalized = (appName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
  const slug = normalized || 'gmail'
  return { slug, displayName: appName.trim() || slug }
}

/**
 * Create a Pipedream Connect Link and send it to the user via WhatsApp.
 * Used when the user asks to connect an app or do something that requires an app they haven't connected yet.
 * Uses Pipedream List Apps API to resolve app name (e.g. "Google Docs") to the correct slug (e.g. google_docs).
 * Single source of truth for connect-link logic (used by API route and AI tool).
 */
export async function createAndSendConnectLink(
  phoneNumber: string,
  appName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { slug, displayName } = await getAppSlugForConnect(appName)
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
