/**
 * Create two reminder rows for a calendar event: 15 min and 5 min before start.
 * Used after creating a one-off event via createCalendarEventViaProxy.
 */

import type { PrismaClient } from '.prisma/client'
import { getPrismaClient } from '@/lib/db/client'

const MINUTES_15 = 15 * 60 * 1000
const MINUTES_5 = 5 * 60 * 1000

export async function createCalendarNudgeReminders(params: {
  userId: string
  timezone: string
  summary: string
  startDateTimeIso: string
  externalEventId?: string | null
}): Promise<void> {
  const { userId, timezone, summary, startDateTimeIso, externalEventId } = params
  const content = (summary || 'Calendar event').trim()
  const tz = (timezone || 'UTC').trim() || 'UTC'

  let start: Date
  try {
    start = new Date(startDateTimeIso)
    if (Number.isNaN(start.getTime())) return
  } catch {
    return
  }

  const dueAt15 = new Date(start.getTime() - MINUTES_15)
  const dueAt5 = new Date(start.getTime() - MINUTES_5)
  const now = new Date()
  if (dueAt5.getTime() <= now.getTime()) return

  type PrismaWithReminder = PrismaClient & {
    reminder: { create: (arg: { data: object }) => Promise<unknown> }
  }
  const prisma = getPrismaClient() as PrismaWithReminder
  if (dueAt15.getTime() > now.getTime()) {
    await prisma.reminder.create({
      data: {
        userId,
        content,
        dueAt: dueAt15,
        timezone: tz,
        status: 'pending',
        source: 'calendar_15min',
        externalEventId: externalEventId ?? undefined,
      },
    })
  }
  await prisma.reminder.create({
    data: {
      userId,
      content,
      dueAt: dueAt5,
      timezone: tz,
      status: 'pending',
      source: 'calendar_5min',
      externalEventId: externalEventId ?? undefined,
    },
  })
}
