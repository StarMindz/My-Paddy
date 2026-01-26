import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma
  }

  // Get DATABASE_URL from environment (runtime connection)
  // DIRECT_URL is only for migrations, not runtime
  const databaseUrl = process.env.DATABASE_URL
  
  // Log for debugging (remove sensitive data in production)
  console.log('[Prisma] Checking environment variables...')
  console.log('[Prisma] DATABASE_URL exists:', !!process.env.DATABASE_URL)
  
  if (!databaseUrl) {
    throw new Error(
      'Missing DATABASE_URL environment variable. ' +
      'Set it in Vercel environment variables. Use DIRECT_URL for migrations only.'
    )
  }

  // Fix SSL in connection string (per pg-connection-string warning)
  // Connection string params override ssl object, so fix it in the URL
  // Add uselibpqcompat=true&sslmode=require to avoid verify-full behavior
  const urlObj = new URL(databaseUrl)
  urlObj.searchParams.set('uselibpqcompat', 'true')
  urlObj.searchParams.set('sslmode', 'require')
  const fixedDatabaseUrl = urlObj.toString()

  // Prisma 7 requires an adapter for database connections
  // Connection string SSL params override ssl object, so fix in URL
  const adapter = new PrismaPg({ connectionString: fixedDatabaseUrl })
  const client = new PrismaClient({ adapter })
  
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
  }

  return client
}
