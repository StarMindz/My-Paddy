/**
 * Core logic for daily morning brief at 6:00 AM user local. Used by /api/cron/tick.
 * For each user where it's 6am in their TZ and we haven't sent today, build a short PA-style brief and send.
 * If the user has Google Calendar connected, fetches today's events and includes them; otherwise reminders only.
 */

import { getPrismaClient } from '@/lib/db/client'
import { getAppConnection } from '@/lib/db/app-connections'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'
import { getTimezoneFromPhone } from '@/lib/context/user-context'
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz'
import { fetchCalendarListViaProxy } from '@/lib/mcp/calendar-list-via-proxy'

type MorningBriefUser = {
  id: string
  phoneNumber: string
  name: string | null
  lastMorningBriefAt: Date | null
}
type ReminderRow = { content: string }
type PrismaCron = ReturnType<typeof getPrismaClient> & {
  user: {
    findMany: (args: { select: { id: true; phoneNumber: true; name: true; lastMorningBriefAt: true } }) => Promise<MorningBriefUser[]>
    update: (args: { where: { id: string }; data: { lastMorningBriefAt: Date } }) => Promise<unknown>
  }
  reminder: { findMany: (args: object) => Promise<ReminderRow[]> }
}

/** Start and end of "today" in the given IANA timezone, as RFC3339 for Google Calendar API. */
function getTodayRangeInTimezone(timezone: string): { timeMin: string; timeMax: string } {
  const now = new Date()
  const zoned = toZonedTime(now, timezone)
  const y = zoned.getFullYear()
  const m = zoned.getMonth()
  const d = zoned.getDate()
  const startUtc = fromZonedTime(new Date(y, m, d, 0, 0, 0), timezone)
  const endUtc = fromZonedTime(new Date(y, m, d + 1, 0, 0, 0), timezone)
  return {
    timeMin: startUtc.toISOString(),
    timeMax: endUtc.toISOString(),
  }
}

/** Google Calendar list response items entry. */
type CalendarEventItem = {
  summary?: string | null
  start?: { dateTime?: string; date?: string } | null
}

const MAX_CALENDAR_EVENTS_IN_BRIEF = 10

/**
 * Parse calendar list API result into short lines for the brief. Returns at most MAX_CALENDAR_EVENTS_IN_BRIEF.
 * Events are formatted with time in the user's timezone (e.g. "Meeting at 2:00 PM" or "All-day event").
 */
function parseCalendarEventsForBrief(
  result: unknown,
  timezone: string
): Array<{ summary: string; timeLabel: string }> {
  if (result == null || typeof result !== 'object' || !('items' in result)) return []
  const items = (result as { items?: unknown[] }).items
  if (!Array.isArray(items)) return []

  const out: Array<{ summary: string; timeLabel: string }> = []
  for (let i = 0; i < items.length && out.length < MAX_CALENDAR_EVENTS_IN_BRIEF; i++) {
    const item = items[i] as CalendarEventItem
    const summary = (item?.summary ?? 'Event').trim() || 'Event'
    const start = item?.start
    let timeLabel: string
    if (start?.dateTime) {
      try {
        const date = new Date(start.dateTime)
        timeLabel = formatInTimeZone(date, timezone, 'h:mm a')
      } catch {
        timeLabel = ''
      }
    } else if (start?.date) {
      timeLabel = 'All day'
    } else {
      timeLabel = ''
    }
    out.push({ summary, timeLabel })
  }
  return out
}

function is6amInTimezone(timezone: string): boolean {
  try {
    const zoned = toZonedTime(new Date(), timezone)
    return zoned.getHours() === 6
  } catch {
    return false
  }
}

function alreadySentToday(lastMorningBriefAt: Date | null, timezone: string): boolean {
  if (!lastMorningBriefAt) return false
  try {
    const zonedLast = toZonedTime(lastMorningBriefAt, timezone)
    const zonedNow = toZonedTime(new Date(), timezone)
    return (
      zonedLast.getFullYear() === zonedNow.getFullYear() &&
      zonedLast.getMonth() === zonedNow.getMonth() &&
      zonedLast.getDate() === zonedNow.getDate()
    )
  } catch {
    return true
  }
}

export async function runMorningBrief(): Promise<{ sent: number }> {
  const prisma = getPrismaClient() as PrismaCron
  const users = await prisma.user.findMany({
    select: { id: true, phoneNumber: true, name: true, lastMorningBriefAt: true },
  })

  let sent = 0
  for (const user of users) {
    const { timezone } = getTimezoneFromPhone(user.phoneNumber)
    if (!is6amInTimezone(timezone)) continue
    if (alreadySentToday(user.lastMorningBriefAt, timezone)) continue

    const todayStart = new Date()
    const reminders = await prisma.reminder.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        dueAt: { gte: todayStart },
      },
      orderBy: { dueAt: 'asc' },
      take: 5,
    })

    let calendarLines: Array<{ summary: string; timeLabel: string }> = []
    const connection = await getAppConnection(user.id, 'google_calendar')
    if (connection?.active && connection.pipedreamConnectionId) {
      try {
        const { timeMin, timeMax } = getTodayRangeInTimezone(timezone)
        const calendarResult = await fetchCalendarListViaProxy(user.id, user.phoneNumber, {
          timeMin,
          timeMax,
          maxResults: MAX_CALENDAR_EVENTS_IN_BRIEF,
        })
        if (!calendarResult.error && calendarResult.result != null) {
          calendarLines = parseCalendarEventsForBrief(calendarResult.result, timezone)
        }
      } catch {
        // Skip calendar on any error (e.g. invalid TZ, API failure); use reminders only
      }
    }

    const name = (user.name || '').trim()
    const greeting = name ? `Good morning, ${name}!` : 'Good morning!'

    const calendarBlock =
      calendarLines.length === 0
        ? ''
        : calendarLines.length === 1
          ? `Today: ${calendarLines[0].summary}${calendarLines[0].timeLabel ? ` at ${calendarLines[0].timeLabel}` : ''}. `
          : `Today: ${calendarLines.map((e) => `${e.summary}${e.timeLabel ? ` at ${e.timeLabel}` : ''}`).join('; ')}. `

    let message: string
    if (calendarBlock && reminders.length > 0) {
      const reminderPart =
        reminders.length === 1
          ? `When you get a chance: ${reminders[0].content}.`
          : `Also:\n${reminders.map((r: ReminderRow) => `• ${r.content}`).join('\n')}`
      message = `${greeting} ${calendarBlock}${reminderPart}`
    } else if (calendarBlock) {
      message = `${greeting} ${calendarBlock.trim()} Hope you're doing well. I'm here if you need anything.`
    } else if (reminders.length === 1) {
      message = `${greeting} When you get a chance today: ${reminders[0].content}.`
    } else if (reminders.length > 1) {
      const lines = reminders.map((r: ReminderRow) => `• ${r.content}`)
      message = `${greeting} A few things for today:\n${lines.join('\n')}`
    } else {
      message = `${greeting} Hope you're doing well. I'm here if you need anything.`
    }

    const result = await sendWhatsAppMessage(user.phoneNumber, message)
    if (!result.success) {
      console.error(`[cron/morning-brief] Failed to send to ${user.id}:`, result.error)
      continue
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastMorningBriefAt: new Date() },
    })
    sent++
  }

  return { sent }
}
