/**
 * Download media (e.g. voice/audio) from WhatsApp Cloud API by media ID.
 *
 * WhatsApp Cloud API flow:
 * 1. GET https://graph.facebook.com/v18.0/{media-id} with Bearer token
 *    → returns JSON with temporary "url" and "mime_type"
 * 2. GET that url with same Bearer token → binary body
 *
 * Voice messages from WhatsApp are typically audio/ogg (Opus), which is
 * supported by OpenAI transcription (mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm, flac).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 */

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!
const GRAPH_API_VERSION = 'v18.0'
const GRAPH_MEDIA_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

export interface DownloadMediaResult {
  data: Buffer
  mimeType: string
}

/**
 * Download media file from WhatsApp by media ID.
 * Uses WHATSAPP_ACCESS_TOKEN for both the metadata request and the binary download.
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<DownloadMediaResult> {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')
  }

  const metaRes = await fetch(`${GRAPH_MEDIA_BASE}/${mediaId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    },
  })

  if (!metaRes.ok) {
    const errBody = await metaRes.text()
    console.error('[WhatsApp media] Meta API error:', metaRes.status, errBody)
    throw new Error(`Failed to get media URL: ${metaRes.status}`)
  }

  const meta = (await metaRes.json()) as { url?: string; mime_type?: string }
  const mediaUrl = meta?.url
  const mimeType = typeof meta?.mime_type === 'string' ? meta.mime_type : 'application/octet-stream'

  if (!mediaUrl || typeof mediaUrl !== 'string') {
    console.error('[WhatsApp media] No url in meta response:', meta)
    throw new Error('Media URL not returned by WhatsApp')
  }

  const binaryRes = await fetch(mediaUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    },
  })

  if (!binaryRes.ok) {
    console.error('[WhatsApp media] Download error:', binaryRes.status)
    throw new Error(`Failed to download media: ${binaryRes.status}`)
  }

  const arrayBuffer = await binaryRes.arrayBuffer()
  const data = Buffer.from(arrayBuffer)

  return { data, mimeType }
}
