import { getPipedreamClient } from '@/lib/mcp/pipedream-auth'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'

/**
 * Create a Pipedream Connect Link and send it to the user via WhatsApp.
 * Used when the user asks to do something (e.g. send email) but hasn't connected the app yet.
 * Single source of truth for connect-link logic (used by API route and AI tool).
 */
export async function createAndSendConnectLink(
  phoneNumber: string,
  appName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const pipedreamClient = getPipedreamClient()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    const webhookUri = baseUrl ? `${baseUrl}/api/connect/link` : undefined
    const tokenResponse = await pipedreamClient.createConnectToken({
      external_user_id: phoneNumber,
      ...(webhookUri && { webhook_uri: webhookUri }),
    } as { external_user_id: string; webhook_uri?: string })
    const connectLink = `${tokenResponse.connect_link_url}&app=${encodeURIComponent(appName)}`
    await sendWhatsAppMessage(
      phoneNumber,
      `🔗 Connect your ${appName} account:\n\n${connectLink}\n\n` +
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
