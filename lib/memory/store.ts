import { getPrismaClient } from '@/lib/db/client'
import { relevanceFromDistance } from './embed'
import {
  computeActivationBaseline,
  activationScore,
} from './activation'
import type { MemoryItem, GetMemoriesResult } from './types'
import { MEMORY_TYPES_STORED } from './types'

/** Vector search: top N by L2 distance in DB (pgvector). */
const VECTOR_TOP_K = 300
/** After re-rank by activation: max items to consider for token cap. */
const RERANK_TOP_K = 20
const TOKEN_BUDGET_DEFAULT = 800
const CHARS_PER_TOKEN = 4

const EMBEDDING_DIMENSIONS = 1536

/** Format embedding array for pgvector: '[0.1,-0.2,...]' */
function toVectorLiteral(arr: number[]): string {
  if (arr.length !== EMBEDDING_DIMENSIONS) return ''
  return '[' + arr.join(',') + ']'
}

/** Raw row from vector search query (snake_case from DB). */
interface VectorSearchRow {
  id: string
  user_id: string
  key: string
  content: string
  type: string
  source_message_id: string | null
  last_recalled_at: Date | null
  recall_count: number
  activation_baseline: number
  created_at: Date
  updated_at: Date
  distance: number
}

function rowToMemoryItem(row: VectorSearchRow): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    content: row.content,
    type: row.type,
    embedding: null,
    sourceMessageId: row.source_message_id,
    lastRecalledAt: row.last_recalled_at,
    recallCount: row.recall_count,
    activationBaseline: row.activation_baseline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Get memories for this turn: vector search top 300 (pgvector), re-rank by activation to top 20, cap by token budget.
 * Returns memories (included set for retain), memoryContext string, and recalledIds (for markRecalled).
 */
export async function getMemoriesForTurn(
  userId: string,
  queryEmbedding: number[],
  options: { tokenBudget?: number } = {}
): Promise<GetMemoriesResult> {
  const tokenBudget = options.tokenBudget ?? TOKEN_BUDGET_DEFAULT
  const prisma = getPrismaClient()

  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    return { memories: [], memoryContext: '', recalledIds: [] }
  }

  const vectorStr = toVectorLiteral(queryEmbedding)
  if (!vectorStr) return { memories: [], memoryContext: '', recalledIds: [] }

  let rows: VectorSearchRow[]
  try {
    rows = await prisma.$queryRaw<VectorSearchRow[]>`
      SELECT id, user_id, key, content, type, source_message_id, last_recalled_at, recall_count,
             activation_baseline, created_at, updated_at,
             (embedding_vector <-> ${vectorStr}::vector) AS distance
      FROM user_memories
      WHERE user_id = ${userId} AND embedding_vector IS NOT NULL
      ORDER BY embedding_vector <-> ${vectorStr}::vector
      LIMIT ${VECTOR_TOP_K}
    `
  } catch (e) {
    console.error('[memory] vector search failed', e instanceof Error ? e.message : e)
    return { memories: [], memoryContext: '', recalledIds: [] }
  }

  if (rows.length === 0) {
    return { memories: [], memoryContext: '', recalledIds: [] }
  }

  const candidates = rows.map(rowToMemoryItem)

  // Re-rank by activation (relevance from DB distance + recency + frequency)
  type WithActivation = { item: MemoryItem; activation: number }
  const withActivation = rows.map((row, i): WithActivation => {
    const item = candidates[i]
    const distance = row.distance
    const rel = relevanceFromDistance(distance)
    const act = activationScore(
      rel,
      item.lastRecalledAt,
      item.updatedAt,
      item.recallCount
    )
    return { item, activation: act }
  })
  withActivation.sort((a, b) => b.activation - a.activation)
  const topK = withActivation.slice(0, RERANK_TOP_K).map((x) => x.item)

  // Fill token budget
  let chars = 0
  const maxChars = tokenBudget * CHARS_PER_TOKEN
  const included: MemoryItem[] = []
  for (const m of topK) {
    const line = `- ${m.content}\n`
    if (chars + line.length > maxChars) break
    chars += line.length
    included.push(m)
  }

  const memoryContext =
    included.length > 0
      ? `What you know about this user:\n${included.map((m) => `- ${m.content}`).join('\n')}`
      : ''

  return {
    memories: included,
    memoryContext,
    recalledIds: included.map((m) => m.id),
  }
}

/**
 * Retain: extract candidates, filter to stored types, upsert (Prisma), then set embedding_vector (raw SQL).
 * Call in waitUntil so it never blocks the reply.
 */
export async function retain(params: {
  userId: string
  userMessage: string
  assistantMessage: string | null
  lastMessageId: string | null
  memoriesFromRecall: MemoryItem[]
}): Promise<{ retained: number }> {
  const { userId, userMessage, assistantMessage, lastMessageId, memoriesFromRecall } = params

  try {
    const { extractMemoryCandidates } = await import('./extract')
    const candidates = await extractMemoryCandidates(
      userMessage,
      assistantMessage,
      memoriesFromRecall
    )
    const toStore = candidates.filter(
      (c) =>
        MEMORY_TYPES_STORED.includes(c.type as (typeof MEMORY_TYPES_STORED)[number]) &&
        c.key !== 'unknown'
    )
    if (toStore.length === 0) return { retained: 0 }

    const prisma = getPrismaClient() as ReturnType<typeof getPrismaClient> & { userMemory: { upsert: (arg: unknown) => Promise<unknown> } }
    const { embed } = await import('./embed')

    let retained = 0
    for (const c of toStore) {
      try {
        const embeddingArr = await embed(c.content)
        const baseline = computeActivationBaseline(null, new Date(), 0)
        const vectorStr = toVectorLiteral(embeddingArr)
        if (!vectorStr) {
          console.error('[memory] retain: invalid embedding length for key', c.key)
          continue
        }

        await prisma.userMemory.upsert({
          where: {
            userId_key: { userId, key: c.key },
          },
          create: {
            userId,
            key: c.key,
            content: c.content,
            type: c.type,
            embedding: embeddingArr,
            sourceMessageId: lastMessageId,
            activationBaseline: baseline,
          },
          update: {
            content: c.content,
            type: c.type,
            embedding: embeddingArr,
            sourceMessageId: lastMessageId,
            updatedAt: new Date(),
          },
        })

        await prisma.$executeRaw`
          UPDATE user_memories
          SET embedding_vector = ${vectorStr}::vector
          WHERE user_id = ${userId} AND key = ${c.key}
        `
        retained++
      } catch (e) {
        console.error('[memory] retain upsert failed for key', c.key, e)
      }
    }
    return { retained }
  } catch (e) {
    console.error('[memory] retain failed', e)
    return { retained: 0 }
  }
}

/**
 * Mark memories as recalled: set lastRecalledAt, increment recallCount, update activationBaseline.
 */
export async function markRecalled(userId: string, memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return
  type UserMemoryRow = { id: string; recallCount: number; updatedAt: Date }
  const prisma = getPrismaClient() as ReturnType<typeof getPrismaClient> & { userMemory: { findMany: (arg: { where: { id: { in: string[] }; userId: string } }) => Promise<UserMemoryRow[]>; update: (arg: unknown) => Promise<unknown> } }
  try {
    const rows = await prisma.userMemory.findMany({
      where: { id: { in: memoryIds }, userId },
    })
    for (const row of rows) {
      const recallCount = (row.recallCount ?? 0) + 1
      const lastRecalledAt = new Date()
      const baseline = computeActivationBaseline(
        lastRecalledAt,
        row.updatedAt,
        recallCount
      )
      await prisma.userMemory.update({
        where: { id: row.id },
        data: {
          lastRecalledAt,
          recallCount,
          activationBaseline: baseline,
        },
      })
    }
  } catch (e) {
    console.error('[memory] markRecalled failed', e)
  }
}
