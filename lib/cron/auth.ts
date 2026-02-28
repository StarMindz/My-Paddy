/**
 * Shared cron auth: validate CRON_SECRET via Authorization: Bearer <CRON_SECRET>.
 * Use from cron route handler (/api/cron/tick).
 */

import { NextRequest, NextResponse } from 'next/server'

export function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  const auth = request.headers.get('authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
