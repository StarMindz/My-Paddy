import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { MemoryItem, MemoryCandidate } from './types'

const MEMORY_TYPE_ENUM = z.enum([
  'fact',
  'preference',
  'belief',
  'relation',
  'commitment',
  'experience',
])

const memoryCandidateSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe('Stable logical key for this slot, e.g. fact_employer, preference_meeting_time. Same topic must use same key when user corrects. Lowercase, no spaces.'),
  content: z.string().min(1).describe('One short sentence: what to remember.'),
  type: MEMORY_TYPE_ENUM,
})

/**
 * Extract memory candidates from the last turn.
 * If the user is correcting something, pass current memories so the model can output the same key.
 */
export async function extractMemoryCandidates(
  userMessage: string,
  assistantMessage: string | null,
  currentMemories: MemoryItem[]
): Promise<MemoryCandidate[]> {
  if (!process.env.OPENAI_API_KEY) {
    return []
  }
  const trimmedUser = (userMessage || '').trim()
  if (!trimmedUser) return []

  const memoryList =
    currentMemories.length > 0
      ? currentMemories
          .slice(0, 50)
          .map((m) => `${m.key}: ${m.content}`)
          .join('\n')
      : '(none yet)'

  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const prompt = `You extract memories to write to the store for this user. Your output is exactly what we will write: each item is either ADDED (new key) or UPDATED (existing key, new content). We do not re-save memories that did not change.

## What to output

- **Only output items that are NEW or CHANGED.**
- **NEW**: Something we don't have yet — use a **new key** (e.g. fact_employer, preference_meeting_time). We will add it.
- **CHANGED**: The user corrected or updated something we already have — use the **exact same key** from Current memories below and the **new content**. We will overwrite that memory.
- **Do NOT output** memories that are already in Current memories and that the user did not change. Do not output greetings, thanks, "ok", or one-off chit-chat. If nothing is new or changed, return an empty array.

So: one list = what to add or update. New key = add. Same key as in Current memories = update that memory. Unchanged memories stay as they are; do not include them.

## Types (use exactly one per item)

- **fact**: Durable information about the user or their world (job, location, family, age). Example: "User works at Acme", "User lives in Lagos".
- **preference**: How the user likes things done (meetings, replies, format). Example: "User prefers morning meetings", "User prefers short replies".
- **belief**: An opinion or belief the user holds. Example: "User believes standups are useful", "User thinks X is high priority".
- **relation**: Who someone is to the user (role, relationship). Example: "User's manager is Sarah", "User's mom lives in Abuja".
- **commitment**: Something the user will do or want to be reminded of. Example: "User will call supplier on July 10", "User wants to exercise more".
- **experience**: A past event we might refer back to. Example: "User created calendar event for Glycobuddy on Feb 1". Use sparingly.

## Rules

1. **key**: Lowercase, no spaces. For a change/correction, use the EXACT same key as in Current memories so we know to update that row. For something new, use a new key (e.g. fact_employer, preference_meeting_time, relation_manager).
2. **content**: One short sentence, third person, e.g. "User prefers morning meetings".
3. Output only new or changed items. Empty array if nothing to add or update.

## Current memories (key: content)

These are already stored. To UPDATE one, use its exact key and the new content. To ADD something we don't have, use a new key. Do not repeat an existing key with the same content (that is unchanged — omit it).

${memoryList}

## This turn

User said: ${JSON.stringify(trimmedUser)}
Assistant said: ${assistantMessage ? JSON.stringify(assistantMessage.slice(0, 500)) : '(no reply yet)'}

Output the list of items to add or update (key, content, type). Empty array if nothing new or changed.`

  const result = await generateText({
    model: openai('gpt-4o-mini'),
    prompt,
    output: Output.object({
      schema: z.object({
        items: z.array(memoryCandidateSchema).describe('List of memory candidates'),
      }),
    }),
  })

  const parsed = result.output as { items?: Array<{ key: string; content: string; type: string }> } | undefined
  const items = parsed?.items ?? []
  return items.map((item) => ({
    key: normalizeKey(item.key),
    content: item.content.trim(),
    type: item.type as MemoryCandidate['type'],
  }))
}

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 128) || 'unknown'
}
