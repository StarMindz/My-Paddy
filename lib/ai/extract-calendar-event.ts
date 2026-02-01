import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CalendarEventSchema = z.object({
  summary: z.string().min(1).max(500),
  startDateTime: z.string(),
  endDateTime: z.string(),
  attendees: z.array(z.string()).optional().default([]),
}).transform((data) => ({
  ...data,
  attendees: (data.attendees || []).filter((e) => typeof e === 'string' && emailRegex.test(e)).slice(0, 50),
}))

export type ExtractedCalendarEvent = z.infer<typeof CalendarEventSchema>

/**
 * Extract structured event details (summary, start, end, optional attendees) from a natural-language
 * instruction. Used when creating calendar events via Connect API Proxy so we
 * control the request body and omit recurrence (single event).
 *
 * Google Calendar API: recurrence is omitted for single events.
 * https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 */
export async function extractCalendarEventFromInstruction(
  instruction: string
): Promise<ExtractedCalendarEvent | null> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[extract-calendar-event] No OPENAI_API_KEY')
      return null
    }
    if (!instruction || typeof instruction !== 'string' || instruction.length > 2000) {
      console.error('[extract-calendar-event] Invalid instruction', { len: instruction?.length, type: typeof instruction })
      return null
    }

    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const result = await generateText({
      model: openai('gpt-4o-mini'),
      prompt: `Extract calendar event details from this instruction. Use the current date/time context for relative times like "tomorrow" or "next Monday". Output startDateTime and endDateTime in ISO 8601 format (include timezone offset when possible, e.g. 2026-01-27T14:00:00+00:00). If only a start time is given, set end to 1 hour after start. If the instruction mentions inviting people, list their email addresses in attendees (array of strings). Today's date is ${new Date().toISOString().slice(0, 10)}.

Instruction: ${instruction.trim()}`,
      output: Output.object({
        schema: z.object({
          summary: z.string().describe('Event title'),
          startDateTime: z.string().describe('Start in ISO 8601'),
          endDateTime: z.string().describe('End in ISO 8601'),
          attendees: z
            .array(z.string().describe('Attendee email address'))
            .describe('List of invitee emails if instruction mentions inviting people; use empty array [] if none'),
        }),
      }),
    })

    const raw = result.output as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') {
      console.error('[extract-calendar-event] Missing or invalid result.output', { hasOutput: !!result.output, outputType: typeof result?.output })
      return null
    }
    const summary = (raw.summary ?? raw.title) as string | undefined
    const startDateTime = (raw.startDateTime ?? raw.start_date_time ?? raw.start) as string | undefined
    const endDateTime = (raw.endDateTime ?? raw.end_date_time ?? raw.end) as string | undefined
    const attendees = Array.isArray(raw.attendees) ? (raw.attendees as string[]) : []
    if (!summary?.trim() || !startDateTime?.trim() || !endDateTime?.trim()) {
      console.error('[extract-calendar-event] Missing required fields', {
        hasSummary: !!summary?.trim(),
        hasStart: !!startDateTime?.trim(),
        hasEnd: !!endDateTime?.trim(),
        keys: Object.keys(raw),
      })
      return null
    }
    const parsed = CalendarEventSchema.safeParse({
      summary: summary.trim(),
      startDateTime: startDateTime.trim(),
      endDateTime: endDateTime.trim(),
      attendees,
    })
    if (!parsed.success) {
      console.error('[extract-calendar-event] Schema validation failed', parsed.error.flatten())
      return null
    }
    return parsed.data
  } catch (err) {
    console.error('[extract-calendar-event] Exception', err instanceof Error ? err.message : err)
    return null
  }
}
