import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma
  }

  // Get DATABASE_URL from environment
  const databaseUrl = process.env.DATABASE_URL || process.env.DIRECT_URL
  
  // Log for debugging (remove sensitive data in production)
  console.log('[Prisma] Checking environment variables...')
  console.log('[Prisma] DATABASE_URL exists:', !!process.env.DATABASE_URL)
  console.log('[Prisma] DIRECT_URL exists:', !!process.env.DIRECT_URL)
  console.log('[Prisma] databaseUrl resolved:', !!databaseUrl)
  
  if (!databaseUrl) {
    const missingVars = []
    if (!process.env.DATABASE_URL) missingVars.push('DATABASE_URL')
    if (!process.env.DIRECT_URL) missingVars.push('DIRECT_URL')
    
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}. ` +
      `Please set DATABASE_URL or DIRECT_URL in your Vercel environment variables.`
    )
  }

  // Ensure DATABASE_URL is set in process.env for Prisma 7 to read
  // This is needed for serverless environments like Vercel
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = databaseUrl
    console.log('[Prisma] Set DATABASE_URL from DIRECT_URL')
  }

  // Prisma 7 requires DATABASE_URL to be in process.env when PrismaClient is instantiated
  // Create client - it will read from process.env.DATABASE_URL
  const client = new PrismaClient()
  
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
  }

  return client
}
