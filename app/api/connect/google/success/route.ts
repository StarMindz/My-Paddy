import { NextResponse } from 'next/server'

/**
 * GET /api/connect/google/success
 * Shown after user completes Google OAuth. They can close the tab.
 */
export async function GET() {
  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail connected</title></head><body><p>Gmail is connected. You can close this window and return to WhatsApp.</p></body></html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  )
}
