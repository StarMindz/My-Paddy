import { getPrismaClient } from './client'

/**
 * Get all active app connections for a user
 */
export async function getActiveAppConnections(userId: string): Promise<Array<{
  appName: string
  pipedreamConnectionId: string | null
}>> {
  const prisma = getPrismaClient() as any
  
  const connections = await prisma.appConnection.findMany({
    where: {
      userId: userId,
      active: true,
      pipedreamConnectionId: {
        not: null
      }
    },
    select: {
      appName: true,
      pipedreamConnectionId: true
    }
  })
  
  return connections
}

/**
 * Get app connection by user ID and app name
 */
export async function getAppConnection(
  userId: string,
  appName: string
): Promise<{
  appName: string
  pipedreamConnectionId: string | null
  active: boolean
} | null> {
  const prisma = getPrismaClient() as any
  
  const connection = await prisma.appConnection.findUnique({
    where: {
      userId_appName: {
        userId: userId,
        appName: appName
      }
    },
    select: {
      appName: true,
      pipedreamConnectionId: true,
      active: true
    }
  })
  
  return connection
}
