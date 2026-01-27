/*
  Warnings:

  - You are about to drop the column `tool_call_id` on the `messages` table. All the data in the column will be lost.
  - You are about to drop the column `tool_calls` on the `messages` table. All the data in the column will be lost.
  - You are about to drop the column `tool_name` on the `messages` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "messages" DROP COLUMN "tool_call_id",
DROP COLUMN "tool_calls",
DROP COLUMN "tool_name",
ADD COLUMN     "toolCallId" TEXT,
ADD COLUMN     "toolCalls" JSONB,
ADD COLUMN     "toolName" TEXT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT;
