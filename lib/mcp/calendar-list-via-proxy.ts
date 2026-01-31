import { getAppConnection } from '@/lib/db/app-connections'
import { getPipedreamClient } from './pipedream-auth'

const GOOGLE_CALENDAR_EVENTS_BASE =
  'https://www.googleapis.com/calendar/v3/calendars'

const DEFAULT_MAX_RESULTS = 50
const DEFAULT_DAYS_AHEAD = 30

/**
 * Fetch Google Calendar events via Pipedream Connect API Proxy.
 * Bypasses MCP sub-agent so we control timeMin/timeMax/maxResults and avoid
 * the proxy's 30-second timeout (unbounded list requests often exceed it).
 *
 * Pipedream docs: https://pipedream.com/docs/connect/api-proxy
 * Google Calendar API: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 */
export async function fetchCalendarListViaProxy(
  userId: string,
  phoneNumber: string,
  options: {
    calendarId?: string
    timeMin?: string // RFC3339
    timeMax?: string // RFC3339
    maxResults?: number
  } = {}
): Promise<{ result: any; error?: string }> {
  const connection = await getAppConnection(userId, 'google_calendar')
  if (!connection || !connection.active) {
    return {
      result: null,
      error: 'No active Google Calendar connection. Please connect the app first.',
    }
  }
  const accountId = connection.pipedreamConnectionId
  if (!accountId) {
    return {
      result: null,
      error: 'Google Calendar account not linked. Please reconnect the app.',
    }
  }

  const calendarId = options.calendarId ?? 'primary'
  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, 250)
  const now = new Date()
  const timeMin = options.timeMin ?? now.toISOString()
  const timeMax =
    options.timeMax ??
    (() => {
      const end = new Date(now)
      end.setDate(end.getDate() + DEFAULT_DAYS_AHEAD)
      return end.toISOString()
    })()

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  })
  const url = `${GOOGLE_CALENDAR_EVENTS_BASE}/${encodeURIComponent(calendarId)}/events?${params.toString()}`

  try {
    const client = getPipedreamClient()
    const response = await client.makeProxyRequest(
      {
        searchParams: {
          external_user_id: phoneNumber,
          account_id: accountId,
        },
      },
      {
        url,
        options: { method: 'GET' },
      }
    )

    if (typeof response === 'string') {
      return { result: response }
    }
    return { result: response }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[Calendar Proxy] Error:', message)
    return {
      result: null,
      error: `Calendar list failed: ${message}`,
    }
  }
}

/**
 * Whether this tool call is a "list calendar events" style call for google_calendar.
 * Used to route to Connect API Proxy instead of MCP sub-agent (avoids timeout).
 */
export function isCalendarListEventsTool(
  toolName: string,
  appName?: string
): boolean {
  const isGoogleCalendar =
    appName === 'google_calendar' || /google_calendar|calendar/.test(toolName)
  const actualName = toolName.startsWith('pd_') ? toolName.slice(3) : toolName
  const looksLikeList =
    /list.*event|list.*calendar|event.*list|get.*event|list_event|list_events/i.test(
      actualName
    ) && !/create|add|insert|delete|update/.test(actualName)
  return !!isGoogleCalendar && !!looksLikeList
}
