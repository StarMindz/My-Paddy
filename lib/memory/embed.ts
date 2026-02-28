/**
 * Embed text using OpenAI text-embedding-3-small (1536 dimensions).
 * Uses fetch to avoid extra SDK surface; same OPENAI_API_KEY as orchestrator.
 */
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

export async function embed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured')
  }
  const trimmed = (text || '').trim()
  if (!trimmed) {
    throw new Error('embed: empty text')
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: trimmed.slice(0, 8000),
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI embeddings error: ${res.status} ${err}`)
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
  const embedding = data.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error('embed: invalid embedding response')
  }
  return embedding
}

/** L2 distance between two vectors (same length). Lower = more similar. */
export function l2Distance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

/** Relevance score from distance: 1 / (1 + distance), so higher = more similar. */
export function relevanceFromDistance(distance: number): number {
  return 1 / (1 + distance)
}
