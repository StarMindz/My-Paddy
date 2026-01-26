import { getPrismaClient } from './client'

export interface SignupState {
  phoneNumber: string
  step: string
  data: Record<string, any> | null
  expiresAt: Date
  createdAt: Date
}

// Get signup state
export async function getSignupState(phoneNumber: string): Promise<SignupState | null> {
  const state = await getPrismaClient().signupState.findUnique({
    where: {
      phoneNumber: phoneNumber
    }
  })

  if (!state) {
    return null
  }

  // Check if expired
  if (state.expiresAt < new Date()) {
    // Delete expired state
    await getPrismaClient().signupState.delete({
      where: {
        phoneNumber: phoneNumber
      }
    })
    return null
  }

  return {
    phoneNumber: state.phoneNumber,
    step: state.step,
    data: state.data as Record<string, any> | null,
    expiresAt: state.expiresAt,
    createdAt: state.createdAt
  }
}

// Set signup state
export async function setSignupState(
  phoneNumber: string,
  step: string,
  data: Record<string, any> | null,
  expiresInMinutes: number = 10
): Promise<void> {
  const expiresAt = new Date()
  expiresAt.setMinutes(expiresAt.getMinutes() + expiresInMinutes)

  await getPrismaClient().signupState.upsert({
    where: {
      phoneNumber: phoneNumber
    },
    update: {
      step,
      data: data as any,
      expiresAt
    },
    create: {
      phoneNumber,
      step,
      data: data as any,
      expiresAt
    }
  })
}

// Clear signup state
export async function clearSignupState(phoneNumber: string): Promise<void> {
  await getPrismaClient().signupState.delete({
    where: {
      phoneNumber: phoneNumber
    }
  }).catch(() => {
    // Ignore if doesn't exist
  })
}

