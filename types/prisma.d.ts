/// <reference types="@prisma/client" />

declare module '@prisma/client' {
  export { PrismaClient, User, AppConnection, Subscription, SignupState } from '.prisma/client/default'
}

