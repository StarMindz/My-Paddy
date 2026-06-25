-- AlterTable: add whatsapp_message_id to messages if not present (for reply-context lookup)
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "whatsapp_message_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "messages_whatsapp_message_id_key" ON "messages"("whatsapp_message_id") WHERE "whatsapp_message_id" IS NOT NULL;

-- CreateTable: message_media (store image for messages so we can show quoted image when user replies)
CREATE TABLE "message_media" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "whatsapp_message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "blob_url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_media_message_id_key" ON "message_media"("message_id");
CREATE INDEX "message_media_whatsapp_message_id_idx" ON "message_media"("whatsapp_message_id");

ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
