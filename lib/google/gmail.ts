/**
 * Gmail API client: send, list, get, modify. Uses stored OAuth tokens (refresh when needed).
 */

import { getPrismaClient } from '@/lib/db/client'
import { refreshAccessToken } from './oauth'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GMAIL_APP_NAME = 'gmail'

/** Get a valid access token for the user's Gmail connection. Refreshes if expired. */
export async function getGmailAccessToken(userId: string): Promise<string | null> {
  const prisma = getPrismaClient() as any
  const conn = await prisma.appConnection.findUnique({
    where: {
      userId_appName: { userId, appName: GMAIL_APP_NAME },
    },
    select: {
      refreshToken: true,
      accessToken: true,
      tokenExpiresAt: true,
      active: true,
    },
  })
  if (!conn?.active || !conn.refreshToken) return null
  const now = new Date()
  const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt) : null
  const bufferSeconds = 60
  if (conn.accessToken && expiresAt && expiresAt.getTime() > now.getTime() + bufferSeconds * 1000) {
    return conn.accessToken
  }
  const { access_token, expires_in } = await refreshAccessToken(conn.refreshToken)
  const newExpiresAt = new Date(Date.now() + expires_in * 1000)
  await prisma.appConnection.update({
    where: { userId_appName: { userId, appName: GMAIL_APP_NAME } },
    data: { accessToken: access_token, tokenExpiresAt: newExpiresAt },
  })
  return access_token
}

async function gmailFetch(userId: string, path: string, init?: RequestInit): Promise<Response> {
  const token = await getGmailAccessToken(userId)
  if (!token) {
    throw new Error('Gmail not connected or token missing. Please connect Gmail first.')
  }
  const url = path.startsWith('http') ? path : `${GMAIL_API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
}

/** Build RFC 2822 message and base64url-encode for Gmail API. */
function buildRawMessage(opts: {
  to: string
  from?: string
  subject: string
  body: string
  cc?: string
  bcc?: string
}): string {
  const lines: string[] = []
  lines.push(`To: ${opts.to}`)
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`)
  lines.push(`Subject: ${opts.subject}`)
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('')
  lines.push(opts.body)
  const raw = lines.join('\r\n')
  return Buffer.from(raw, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface SendEmailParams {
  to: string
  subject: string
  body: string
  cc?: string
  bcc?: string
}

export async function sendEmail(
  userId: string,
  params: SendEmailParams
): Promise<{ id?: string; error?: string }> {
  const raw = buildRawMessage({
    to: params.to,
    subject: params.subject,
    body: params.body,
    cc: params.cc,
    bcc: params.bcc,
  })
  const res = await gmailFetch(userId, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail send failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { id?: string }
  return { id: data.id }
}

export interface CreateDraftParams {
  to: string
  subject: string
  body: string
  cc?: string
  bcc?: string
}

export async function createDraft(
  userId: string,
  params: CreateDraftParams
): Promise<{ id?: string; error?: string }> {
  const raw = buildRawMessage({
    to: params.to,
    subject: params.subject,
    body: params.body,
    cc: params.cc,
    bcc: params.bcc,
  })
  const res = await gmailFetch(userId, '/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw } }),
  })
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail create draft failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { id?: string }
  return { id: data.id }
}

export interface ListMessagesParams {
  q?: string
  maxResults?: number
  pageToken?: string
  labelIds?: string[]
}

export async function listMessages(
  userId: string,
  params: ListMessagesParams = {}
): Promise<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; error?: string }> {
  const qs = new URLSearchParams()
  if (params.q) qs.set('q', params.q)
  qs.set('maxResults', String(Math.min(params.maxResults ?? 20, 100)))
  if (params.pageToken) qs.set('pageToken', params.pageToken)
  if (params.labelIds?.length) params.labelIds.forEach((id) => qs.append('labelIds', id))
  const res = await gmailFetch(userId, `/messages?${qs.toString()}`)
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail list failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }
  return { messages: data.messages ?? [], nextPageToken: data.nextPageToken }
}

export async function getMessage(
  userId: string,
  messageId: string,
  format: 'minimal' | 'full' | 'raw' = 'full'
): Promise<{ message?: Record<string, unknown>; error?: string }> {
  const res = await gmailFetch(userId, `/messages/${encodeURIComponent(messageId)}?format=${format}`)
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail get message failed: ${res.status} ${err}` }
  }
  const message = (await res.json()) as Record<string, unknown>
  return { message }
}

export interface ModifyMessageParams {
  addLabelIds?: string[]
  removeLabelIds?: string[]
}

export async function modifyMessage(
  userId: string,
  messageId: string,
  params: ModifyMessageParams
): Promise<{ message?: Record<string, unknown>; error?: string }> {
  const res = await gmailFetch(userId, `/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    body: JSON.stringify({
      addLabelIds: params.addLabelIds ?? [],
      removeLabelIds: params.removeLabelIds ?? [],
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail modify failed: ${res.status} ${err}` }
  }
  const message = (await res.json()) as Record<string, unknown>
  return { message }
}

/** Mark as read: remove UNREAD label. */
export async function markRead(userId: string, messageId: string): Promise<{ error?: string }> {
  const r = await modifyMessage(userId, messageId, { removeLabelIds: ['UNREAD'] })
  return r.error ? { error: r.error } : {}
}

/** Archive: remove INBOX label. */
export async function archiveMessage(userId: string, messageId: string): Promise<{ error?: string }> {
  const r = await modifyMessage(userId, messageId, { removeLabelIds: ['INBOX'] })
  return r.error ? { error: r.error } : {}
}

/** Move to trash. */
export async function trashMessage(userId: string, messageId: string): Promise<{ error?: string }> {
  const token = await getGmailAccessToken(userId)
  if (!token) return { error: 'Gmail not connected.' }
  const res = await gmailFetch(userId, `/messages/${encodeURIComponent(messageId)}/trash`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail trash failed: ${res.status} ${err}` }
  }
  return {}
}

/** Permanently delete a message. */
export async function deleteMessage(userId: string, messageId: string): Promise<{ error?: string }> {
  const res = await gmailFetch(userId, `/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 204) {
    const err = await res.text()
    return { error: `Gmail delete failed: ${res.status} ${err}` }
  }
  return {}
}

export async function addLabelsToMessage(
  userId: string,
  messageId: string,
  labelIds: string[]
): Promise<{ message?: Record<string, unknown>; error?: string }> {
  return modifyMessage(userId, messageId, { addLabelIds: labelIds })
}

export async function removeLabelsFromMessage(
  userId: string,
  messageId: string,
  labelIds: string[]
): Promise<{ message?: Record<string, unknown>; error?: string }> {
  return modifyMessage(userId, messageId, { removeLabelIds: labelIds })
}

export async function listThreadMessages(
  userId: string,
  threadId: string
): Promise<{ messages?: Array<Record<string, unknown>>; error?: string }> {
  const res = await gmailFetch(userId, `/threads/${encodeURIComponent(threadId)}?format=full`)
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail list thread failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { messages?: Array<Record<string, unknown>> }
  return { messages: data.messages ?? [] }
}

export interface GmailLabel {
  id: string
  name: string
}

export async function listLabels(userId: string): Promise<{ labels?: GmailLabel[]; error?: string }> {
  const res = await gmailFetch(userId, '/labels')
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail list labels failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { labels?: GmailLabel[] }
  return { labels: data.labels ?? [] }
}

export async function createLabel(
  userId: string,
  name: string
): Promise<{ label?: GmailLabel; error?: string }> {
  const res = await gmailFetch(userId, '/labels', {
    method: 'POST',
    body: JSON.stringify({
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail create label failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as GmailLabel
  return { label: data }
}

export interface GmailSendAsAlias {
  sendAsEmail: string
  displayName?: string
  isPrimary?: boolean
  isDefault?: boolean
  signature?: string
}

export async function listSendAsAliases(
  userId: string
): Promise<{ aliases?: GmailSendAsAlias[]; error?: string }> {
  const res = await gmailFetch(userId, '/settings/sendAs')
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail list send-as aliases failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { sendAs?: GmailSendAsAlias[] }
  return { aliases: data.sendAs ?? [] }
}

export async function getSendAsAlias(
  userId: string,
  sendAsEmail: string
): Promise<{ alias?: GmailSendAsAlias; error?: string }> {
  const res = await gmailFetch(
    userId,
    `/settings/sendAs/${encodeURIComponent(sendAsEmail)}`
  )
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail get send-as alias failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as GmailSendAsAlias
  return { alias: data }
}

export async function updatePrimarySignature(
  userId: string,
  signature: string
): Promise<{ alias?: GmailSendAsAlias; error?: string }> {
  const aliasesResult = await listSendAsAliases(userId)
  if (aliasesResult.error) {
    return { error: aliasesResult.error }
  }
  const aliases = aliasesResult.aliases ?? []
  const primary =
    aliases.find((a) => a.isPrimary) ||
    aliases.find((a) => a.isDefault) ||
    aliases[0]
  if (!primary || !primary.sendAsEmail) {
    return { error: 'No send-as alias found to update signature.' }
  }

  const res = await gmailFetch(
    userId,
    `/settings/sendAs/${encodeURIComponent(primary.sendAsEmail)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ signature }),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    return { error: `Gmail update primary signature failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as GmailSendAsAlias
  return { alias: data }
}
