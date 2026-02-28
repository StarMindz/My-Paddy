/**
 * Memory types we store. The extractor only returns these; nothing else is stored.
 */
export const MEMORY_TYPES_STORED = [
  'fact',
  'preference',
  'belief',
  'relation',
  'commitment',
  'experience',
] as const

export type MemoryTypeStored = (typeof MEMORY_TYPES_STORED)[number]

export interface MemoryItem {
  id: string
  userId: string
  key: string
  content: string
  type: string
  embedding: number[] | null
  sourceMessageId: string | null
  lastRecalledAt: Date | null
  recallCount: number
  activationBaseline: number
  createdAt: Date
  updatedAt: Date
}

export interface MemoryCandidate {
  key: string
  content: string
  type: MemoryTypeStored
}

export interface GetMemoriesResult {
  memories: MemoryItem[]
  memoryContext: string
  recalledIds: string[]
}

export interface RetainParams {
  userId: string
  userMessage: string
  assistantMessage: string | null
  lastMessageId: string | null
  memoriesFromRecall: MemoryItem[]
}
