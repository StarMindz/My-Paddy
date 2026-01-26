import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

/**
 * Extract email or name from natural language input using AI with structured output
 * Returns the extracted value or null if extraction fails
 * 
 * Security: Structured outputs with Zod schemas prevent prompt injection by constraining
 * the output format. The model can only return data matching the schema.
 */
export async function extractSignupData(
  userInput: string,
  field: 'email' | 'name'
): Promise<string | null> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[AI] OPENAI_API_KEY not configured')
      return null
    }

    // Basic input validation - length limit to prevent DoS
    if (!userInput || typeof userInput !== 'string' || userInput.length > 1000) {
      return null
    }

    const trimmedInput = userInput.trim()

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    const prompt = field === 'email'
      ? `Extract the email address from this user message. If no valid email is found, return an empty string.

User message: ${JSON.stringify(trimmedInput)}

Examples:
- "my email is john@example.com" → "john@example.com"
- "it's stanley@test.com" → "stanley@test.com"
- "john@example.com" → "john@example.com"
- "I don't have one" → ""`

      : `Extract the person's name from this user message. If no name is found, return an empty string.

User message: ${JSON.stringify(trimmedInput)}

Examples:
- "my name is Stanley Nnamani" → "Stanley Nnamani"
- "I'm John" → "John"
- "Stanley" → "Stanley"
- "call me Stan" → "Stan"
- "I don't want to share" → ""`

    // Use different schemas based on field type
    const result = field === 'email'
      ? await generateText({
          model: openai('gpt-5.2'),
          prompt,
          output: Output.object({
            schema: z.object({
              email: z.string().email().describe('The extracted email address, or empty string if not found'),
            }),
          }),
        })
      : await generateText({
          model: openai('gpt-5.2'),
          prompt,
          output: Output.object({
            schema: z.object({
              name: z.string().min(2).max(100).describe('The extracted name, or empty string if not found'),
            }),
          }),
        })

    // Extract the value from the structured output (property is 'output', not 'object')
    const extracted = field === 'email' 
      ? (result.output as { email: string }).email?.trim() || null
      : (result.output as { name: string }).name?.trim() || null

    // Final validation
    if (!extracted) {
      return null
    }

    // Additional validation for email (schema already validates, but double-check)
    if (field === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(extracted)) {
        return null
      }
    }

    // Additional validation for name (schema already validates length, but double-check)
    if (field === 'name') {
      if (extracted.length < 2 || extracted.length > 100) {
        return null
      }
    }

    return extracted
  } catch (error) {
    console.error(`[AI] Error extracting ${field}:`, error)
    return null
  }
}

