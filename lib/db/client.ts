import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

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

  // Prisma 7 requires an adapter for database connections
  // Create a PostgreSQL connection pool
  const pool = new Pool({ connectionString: databaseUrl })
  const adapter = new PrismaPg(pool)

  // Create PrismaClient with the adapter
  const client = new PrismaClient({ adapter })
  
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
  }

  return client
}
