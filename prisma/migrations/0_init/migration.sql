-- Baseline migration: Existing tables that are already in the database
-- This migration is marked as applied since tables already exist

-- CreateTable (already exists - baseline)
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "subscription_tier" TEXT NOT NULL DEFAULT 'free',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable (already exists - baseline)
CREATE TABLE "app_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "pipedream_connection_id" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "app_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable (already exists - baseline)
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT,
    "provider_subscription_id" TEXT,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable (already exists - baseline)
CREATE TABLE "signup_states" (
    "phone_number" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "data" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_states_pkey" PRIMARY KEY ("phone_number")
);

-- CreateIndex (already exists - baseline)
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex (already exists - baseline)
CREATE UNIQUE INDEX "app_connections_user_id_app_name_key" ON "app_connections"("user_id", "app_name");

-- AddForeignKey (already exists - baseline)
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (already exists - baseline)
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
