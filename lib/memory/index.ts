/**
 * Memory module: recall (get memories for prompt + for retain context) and retain (extract + upsert).
 * Feature flag: MEMORY_ENABLED (env) to enable.
 */

import { embed } from './embed'
import { getMemoriesForTurn as getMemoriesForTurnImpl, retain, markRecalled } from './store'
import type { GetMemoriesResult, MemoryItem, RetainParams } from './types'

export type { MemoryItem, GetMemoriesResult, RetainParams }
export { retain, markRecalled }

const RECALL_TIMEOUT_MS = 2000
const TOKEN_BUDGET_DEFAULT = 800

/**
 * Get memory context for this turn: embed query, fetch memories (hybrid + re-rank), return string for prompt and list for retain.
 * On failure or timeout returns empty context; does not throw.
 */
export async function getMemoriesForTurn(
  userId: string,
  currentMessage: string,
  options: { tokenBudget?: number } = {}
): Promise<GetMemoriesResult> {
  const tokenBudget = options.tokenBudget ?? TOKEN_BUDGET_DEFAULT
  if (!currentMessage?.trim()) {
    return { memories: [], memoryContext: '', recalledIds: [] }
  }
  const timeout = new Promise<GetMemoriesResult>((_, reject) =>
    setTimeout(() => reject(new Error('getMemoriesForTurn timeout')), RECALL_TIMEOUT_MS)
  )
  const work = (async (): Promise<GetMemoriesResult> => {
    const queryEmbedding = await embed(currentMessage.trim() || ' ')
    return getMemoriesForTurnImpl(userId, queryEmbedding, { tokenBudget })
  })()
  try {
    return await Promise.race([work, timeout])
  } catch (e) {
    console.error('[memory] getMemoriesForTurn failed', e instanceof Error ? e.message : e)
    return { memories: [], memoryContext: '', recalledIds: [] }
  }
}
