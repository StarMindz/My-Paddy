-- Add lastMorningBriefAt to users for daily brief tracking
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_morning_brief_at" TIMESTAMP(3);

-- CreateTable: reminders
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'standalone',
    "external_event_id" TEXT,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reminders_status_due_at_idx" ON "reminders"("status", "due_at");
CREATE INDEX "reminders_user_id_status_idx" ON "reminders"("user_id", "status");

ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
