/**
 * Create a reminder for a user. Used when the AI calls create_reminder.
 * AI passes dueAt as ISO 8601 (e.g. "2026-01-28T15:00:00Z" or with offset).
 * No parsing — the AI is responsible for converting "tomorrow 3pm" to ISO.
 */

import type { PrismaClient } from '.prisma/client'
import { getPrismaClient } from '@/lib/db/client'
import { formatInTimeZone } from 'date-fns-tz'

export type CreateReminderParams = {
  userId: string
  content: string
  dueAt: string
  timezone: string
}

export type CreateReminderResult =
  | { success: true; message: string }
  | { success: false; error: string }

/**
 * Create a single reminder. AI passes dueAt (ISO 8601). Validates it's in the future.
 * Returns a factual result for the AI (success + due time). The AI composes the user-facing response.
 */
export async function createReminder(params: CreateReminderParams): Promise<CreateReminderResult> {
  const { userId, content, dueAt, timezone } = params
  const tz = (timezone || 'UTC').trim() || 'UTC'
  const contentTrimmed = (content || '').trim()
  if (!contentTrimmed) {
    return { success: false, error: 'Reminder content is required.' }
  }

  const dueDate = new Date(dueAt)
  if (Number.isNaN(dueDate.getTime())) {
    return { success: false, error: 'Invalid date. Pass dueAt as ISO 8601 (e.g. 2026-01-28T15:00:00Z).' }
  }
  const now = new Date()
  if (dueDate.getTime() <= now.getTime()) {
    return { success: false, error: 'That time is in the past. Please give a future time.' }
  }

  const prisma = getPrismaClient() as PrismaClient
  await (prisma as PrismaClient & { reminder: { create: (arg: { data: object }) => Promise<unknown> } }).reminder.create({
    data: {
      userId,
      content: contentTrimmed,
      dueAt: dueDate,
      timezone: tz,
      status: 'pending',
      source: 'standalone',
    },
  })

  const timeLabel = formatInTimeZone(dueDate, tz, 'h:mm a')
  return { success: true, message: `Reminder created. Due at ${timeLabel} (user's local time).` }
}
