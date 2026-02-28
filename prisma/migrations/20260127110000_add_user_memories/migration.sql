-- CreateTable: user_memories (required before add_pgvector_memory can alter it)
CREATE TABLE "user_memories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "embedding" JSONB,
    "source_message_id" TEXT,
    "last_recalled_at" TIMESTAMP(3),
    "recall_count" INTEGER NOT NULL DEFAULT 0,
    "activation_baseline" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one row per (user_id, key)
CREATE UNIQUE INDEX "user_memories_user_id_key_key" ON "user_memories"("user_id", "key");

-- Indexes for recall queries
CREATE INDEX "user_memories_user_id_idx" ON "user_memories"("user_id");
CREATE INDEX "user_memories_user_id_activation_baseline_idx" ON "user_memories"("user_id", "activation_baseline");

-- Foreign key
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
