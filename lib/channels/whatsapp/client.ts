const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!

if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
  console.warn('WhatsApp credentials not configured')
}

export interface SendMessageResult {
  success: boolean
  messageId?: string
  error?: string
}

/**
 * Internal helper to call the WhatsApp messages endpoint.
 * Used for both text messages and typing indicators.
 */
async function callWhatsAppMessagesEndpoint(
  body: Record<string, any>
): Promise<Response | null> {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    console.warn('WhatsApp credentials not configured')
    return null
  }

  const response = await fetch(
    `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  )

  return response
}

/**
 * Send a WhatsApp message to a user.
 */
export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<SendMessageResult> {
  try {
    const response = await callWhatsAppMessagesEndpoint({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: message
      }
    })

    if (!response) {
      return {
        success: false,
        error: 'WhatsApp credentials not configured'
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || 'Failed to send message'
      console.error('WhatsApp API error:', errorMessage)
      return {
        success: false,
        error: errorMessage
      }
    }

    const data = await response.json()
    return {
      success: true,
      messageId: data.messages?.[0]?.id
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Send a typing indicator for an incoming message.
 *
 * This uses the official WhatsApp Cloud API typing indicators endpoint:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 *
 * The indicator is dismissed automatically when you send a reply
 * or after ~25 seconds.
 */
export async function sendTypingIndicator(
  incomingMessageId: string
): Promise<void> {
  if (!incomingMessageId) {
    return
  }

  try {
    const response = await callWhatsAppMessagesEndpoint({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: incomingMessageId,
      typing_indicator: {
        type: 'text'
      }
    })

    if (!response) {
      return
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage =
        (errorData as any).error?.message || 'Failed to send typing indicator'
      console.error('WhatsApp typing indicator API error:', errorMessage)
    }
  } catch (error) {
    console.error('Error sending WhatsApp typing indicator:', error)
  }
}
