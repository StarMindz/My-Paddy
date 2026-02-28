import { getPrismaClient } from './client'
import { User } from '@prisma/client'

// Get user by phone number
export async function getUserByPhone(phoneNumber: string): Promise<User | null> {
  return await getPrismaClient().user.findUnique({
    where: {
      phoneNumber: phoneNumber
    }
  })
}

// Get user by id (e.g. for cron: reminder.userId -> phoneNumber)
export async function getUserById(id: string): Promise<User | null> {
  return await getPrismaClient().user.findUnique({
    where: { id },
  })
}

// Create user
export async function createUser(userData: {
  phone_number: string
  email: string
  name: string
}): Promise<User> {
  return await getPrismaClient().user.create({
    data: {
      phoneNumber: userData.phone_number,
      email: userData.email,
      name: userData.name,
      subscriptionTier: 'free'
    }
  })
}

