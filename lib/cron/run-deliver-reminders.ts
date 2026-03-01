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
  }
}

export async function runDeliverReminders(): Promise<{ delivered: number }> {
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

  return { delivered }
}
