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
  if (!process.env.DATABASE_URL && process.env.DIRECT_URL) {
    process.env.DATABASE_URL = process.env.DIRECT_URL
  }


  const client = new PrismaClient()
  
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
  }

  return client
}
