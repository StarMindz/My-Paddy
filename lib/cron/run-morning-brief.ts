/**
 * Core logic for daily morning brief at 6:00 AM user local. Used by /api/cron/tick.
 * For each user where it's 6am in their TZ and we haven't sent today, build a short PA-style brief and send.
 */

import { getPrismaClient } from '@/lib/db/client'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'
import { getTimezoneFromPhone } from '@/lib/context/user-context'
import { toZonedTime } from 'date-fns-tz'

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

    const name = (user.name || '').trim()
    const greeting = name ? `Good morning, ${name}!` : 'Good morning!'

    let message: string
    if (reminders.length === 0) {
      message = `${greeting} Hope you're doing well. I'm here if you need anything.`
    } else if (reminders.length === 1) {
      message = `${greeting} When you get a chance today: ${reminders[0].content}.`
    } else {
      const lines = reminders.map((r: ReminderRow) => `• ${r.content}`)
      message = `${greeting} A few things for today:\n${lines.join('\n')}`
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
