/**
 * Core logic for delivering due reminders. Used by /api/cron/tick.
 * Queries pending reminders with dueAt <= now; sends each reminder's content as the message; marks sent only after successful delivery.
 */

import { getPrismaClient } from '@/lib/db/client'
import { getUserById } from '@/lib/db/users'
import { sendWhatsAppMessage } from '@/lib/channels/whatsapp/client'
import { appendOutboundToConversation } from '@/lib/db/messages'

type ReminderRow = { id: string; userId: string; content: string }
type PrismaWithReminder = ReturnType<typeof getPrismaClient> & {
  reminder: {
    findMany: (args: object) => Promise<ReminderRow[]>
    updateMany: (args: object) => Promise<unknown>
    deleteMany: (args: { where: { status: string; sentAt: { lt: Date } } }) => Promise<{ count: number }>
  }
}

const SENT_REMINDER_RETENTION_DAYS = 1

/** Delete sent reminders older than SENT_REMINDER_RETENTION_DAYS so the table doesn't grow indefinitely. */
export async function deleteSentRemindersOlderThanRetention(): Promise<{ deleted: number }> {
  const prisma = getPrismaClient() as PrismaWithReminder
  const cutoff = new Date(Date.now() - SENT_REMINDER_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const result = await prisma.reminder.deleteMany({
    where: {
      status: 'sent',
      sentAt: { lt: cutoff },
    },
  })
  let deleted = result.count

  const prismaAny = getPrismaClient() as any
  const nullSentResult = await prismaAny.reminder.deleteMany({
    where: { status: 'sent', sentAt: null },
  })
  deleted += nullSentResult.count

  return { deleted }
}

export async function runDeliverReminders(): Promise<{ delivered: number; deleted: number }> {
  const prisma = getPrismaClient() as PrismaWithReminder
  const now = new Date()

  const due = await prisma.reminder.findMany({
    where: {
      status: 'pending',
      dueAt: { lte: now },
    },
    orderBy: { dueAt: 'asc' },
  })

  let delivered = 0
  for (const r of due) {
    const user = await getUserById(r.userId)
    if (!user?.phoneNumber) continue

    const message = (r.content || '').trim()
    const skipSend = !message
    if (!skipSend) {
      const result = await sendWhatsAppMessage(user.phoneNumber, message)
      if (!result.success) {
        console.error(`[cron/deliver-reminders] Failed to send reminder ${r.id} to ${r.userId}:`, result.error)
        continue
      }
      delivered++
      try {
        await appendOutboundToConversation(r.userId, 'reminder', message)
      } catch (err) {
        console.error(`[cron/deliver-reminders] Failed to append reminder to conversation for ${r.userId}:`, err)
      }
    }

    await prisma.reminder.updateMany({
      where: { id: r.id },
      data: { status: 'sent', sentAt: now },
    })
  }

  const { deleted } = await deleteSentRemindersOlderThanRetention()
  return { delivered, deleted }
}
