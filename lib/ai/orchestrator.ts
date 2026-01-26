import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

/**
 * Process user message with AI and return response
 * No tool calling - just conversational AI for now
 */
export async function processUserMessage(
  userMessage: string,
  userName?: string
): Promise<string | null> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[AI] OPENAI_API_KEY not configured')
      return null
    }

    // Basic input validation
    if (!userMessage || typeof userMessage !== 'string' || userMessage.length > 1000) {
      return null
    }

    const trimmedMessage = userMessage.trim()
    if (!trimmedMessage) {
      return null
    }

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    // System prompt for My Padi assistant
    const systemPrompt = `You are My Padi, a helpful AI assistant available on WhatsApp. You help users with productivity tasks like:
- Creating calendar events
- Sending emails
- Managing tasks
- Answering questions
- Providing helpful information

Be friendly, concise, and helpful. Keep responses appropriate for WhatsApp (not too long). 
${userName ? `The user's name is ${userName}.` : ''}

If the user asks about features that require integrations (like calendar or email), let them know these features are coming soon.`

    const result = await generateText({
      model: openai('gpt-5.2'),
      system: systemPrompt,
      prompt: trimmedMessage,
    })

    const response = result.text.trim()
    
    if (!response) {
      return null
    }

    return response
  } catch (error) {
    console.error('[AI] Error processing user message:', error)
    return null
  }
}

