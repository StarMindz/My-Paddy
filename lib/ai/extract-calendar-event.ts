import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

const CalendarEventSchema = z.object({
  summary: z.string().min(1).max(500),
  startDateTime: z.string(),
  endDateTime: z.string(),
})

export type ExtractedCalendarEvent = z.infer<typeof CalendarEventSchema>

/**
 * Extract structured event details (summary, start, end) from a natural-language
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
    if (!process.env.OPENAI_API_KEY) return null
    if (!instruction || typeof instruction !== 'string' || instruction.length > 2000) return null

    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const result = await generateText({
      model: openai('gpt-4o-mini'),
      prompt: `Extract calendar event details from this instruction. Use the current date/time context for relative times like "tomorrow" or "next Monday". Output startDateTime and endDateTime in ISO 8601 format (include timezone offset when possible, e.g. 2026-01-27T14:00:00+00:00). If only a start time is given, set end to 1 hour after start. Today's date is ${new Date().toISOString().slice(0, 10)}.

Instruction: ${instruction.trim()}`,
      output: Output.object({
        schema: z.object({
          summary: z.string().describe('Event title'),
          startDateTime: z.string().describe('Start in ISO 8601'),
          endDateTime: z.string().describe('End in ISO 8601'),
        }),
      }),
    })

    const raw = result.output as { summary?: string; startDateTime?: string; endDateTime?: string } | undefined
    if (!raw?.summary || !raw?.startDateTime || !raw?.endDateTime) return null
    const parsed = CalendarEventSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
