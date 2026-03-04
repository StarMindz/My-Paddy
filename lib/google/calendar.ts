/**
 * Google Calendar API client: list and create events using stored OAuth tokens.
 */

import { getPrismaClient } from '@/lib/db/client'
import { refreshAccessToken } from './oauth'

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_CALENDAR_APP_NAME = 'google_calendar'

async function getCalendarAccessToken(userId: string): Promise<string | null> {
  const prisma = getPrismaClient() as any
  const conn = await prisma.appConnection.findUnique({
    where: {
      userId_appName: { userId, appName: GOOGLE_CALENDAR_APP_NAME },
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
    where: { userId_appName: { userId, appName: GOOGLE_CALENDAR_APP_NAME } },
    data: { accessToken: access_token, tokenExpiresAt: newExpiresAt },
  })
  return access_token
}

async function calendarFetch(userId: string, path: string, init?: RequestInit): Promise<Response> {
  const token = await getCalendarAccessToken(userId)
  if (!token) {
    throw new Error('Google Calendar not connected or token missing. Please connect Calendar first.')
  }
  const url = path.startsWith('http') ? path : `${CALENDAR_API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
}

export interface CreateCalendarEventParams {
  summary: string
  startDateTime: string // ISO 8601
  endDateTime: string // ISO 8601
  description?: string
  location?: string
  attendees?: string[]
  /** Minutes before the event to trigger a reminder (popup). One value or array (max 5). API: reminders.overrides */
  reminderMinutes?: number | number[]
}

export async function createCalendarEvent(
  userId: string,
  params: CreateCalendarEventParams
): Promise<{ id?: string; htmlLink?: string; error?: string }> {
  if (!params.summary?.trim()) {
    return { error: 'Event summary is required.' }
  }
  const attendeeEmails = Array.isArray(params.attendees)
    ? params.attendees.filter((e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 50)
    : []

  const body: any = {
    summary: params.summary.slice(0, 1024),
    start: { dateTime: params.startDateTime },
    end: { dateTime: params.endDateTime },
  }
  if (params.description) body.description = params.description.slice(0, 8192)
  if (params.location) body.location = params.location.slice(0, 1024)
  if (attendeeEmails.length > 0) {
    body.attendees = attendeeEmails.map((email) => ({ email }))
  }
  if (params.reminderMinutes != null) {
    const minutes = Array.isArray(params.reminderMinutes)
      ? params.reminderMinutes.filter((m) => typeof m === 'number' && m >= 0 && m <= 40320).slice(0, 5)
      : [params.reminderMinutes].filter((m) => typeof m === 'number' && m >= 0 && m <= 40320)
    if (minutes.length > 0) {
      body.reminders = {
        useDefault: false,
        overrides: minutes.map((m) => ({ method: 'popup' as const, minutes: m })),
      }
    }
  }

  const url =
    attendeeEmails.length > 0
      ? `${CALENDAR_API_BASE}/calendars/primary/events?sendUpdates=all`
      : `${CALENDAR_API_BASE}/calendars/primary/events`

  const res = await calendarFetch(userId, url, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    return { error: `Calendar create event failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { id?: string; htmlLink?: string }
  return { id: data.id, htmlLink: data.htmlLink }
}

export interface ListCalendarEventsParams {
  timeMin?: string // ISO 8601
  timeMax?: string // ISO 8601
  maxResults?: number
  calendarId?: string
}

export async function listCalendarEvents(
  userId: string,
  params: ListCalendarEventsParams = {}
): Promise<{ events?: Array<Record<string, any>>; error?: string }> {
  const calendarId = params.calendarId || 'primary'
  const now = new Date()
  const timeMin = params.timeMin || now.toISOString()
  const timeMax =
    params.timeMax ||
    (() => {
      const end = new Date(now)
      end.setDate(end.getDate() + 30)
      return end.toISOString()
    })()
  const maxResults = Math.min(params.maxResults ?? 50, 250)

  const qs = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  })

  const res = await calendarFetch(userId, `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`)
  if (!res.ok) {
    const err = await res.text()
    return { error: `Calendar list events failed: ${res.status} ${err}` }
  }
  const data = (await res.json()) as { items?: Array<Record<string, any>> }
  return { events: data.items ?? [] }
}

