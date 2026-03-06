/**
 * Media attached to a user message (image, and later video, document, etc.).
 * Used when the user sends a message with an attachment so the model can see it.
 *
 * WhatsApp: when a user attaches media to a message, the text they type is the
 * caption (e.g. message.image.caption). One message = one type + optional caption.
 */
export type MediaAttachment =
  | { kind: 'image'; data: Buffer; mimeType: string }
  // Future: | { kind: 'video'; data: Buffer; mimeType: string }
  // Future: | { kind: 'document'; data: Buffer; mimeType: string; filename?: string }
