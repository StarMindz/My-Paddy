/**
 * Single cron entry point: run every minute (e.g. cron-job.org).
 * CRON_SECRET must be set and sent in Authorization: Bearer <CRON_SECRET>.
 * Runs (1) deliver due reminders and (2) morning brief for users where it's 6am local. One URL to configure.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron/auth'
import { runDeliverReminders } from '@/lib/cron/run-deliver-reminders'
import { runMorningBrief } from '@/lib/cron/run-morning-brief'

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request)
  if (authError) return authError

  const { delivered, deleted } = await runDeliverReminders()
  const { sent } = await runMorningBrief()

  return NextResponse.json({ ok: true, delivered, deleted, morningBriefSent: sent })
}
