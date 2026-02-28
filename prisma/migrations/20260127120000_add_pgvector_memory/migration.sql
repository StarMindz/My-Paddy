-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Add vector column for embeddings (1536 = text-embedding-3-small)
ALTER TABLE "user_memories" ADD COLUMN IF NOT EXISTS "embedding_vector" vector(1536);

-- Backfill: copy existing embedding (jsonb array) to embedding_vector only when length = 1536
DO $$
DECLARE
  r RECORD;
  vec text;
BEGIN
  FOR r IN SELECT id, embedding FROM "user_memories"
    WHERE embedding IS NOT NULL AND embedding_vector IS NULL
    AND jsonb_array_length(embedding::jsonb) = 1536
  LOOP
    SELECT '[' || string_agg(t.value, ',' ORDER BY t.ord) || ']'
    INTO vec
    FROM jsonb_array_elements_text(r.embedding::jsonb) WITH ORDINALITY AS t(value, ord);
    IF vec IS NOT NULL AND vec != '[]' THEN
      UPDATE "user_memories" SET embedding_vector = vec::vector(1536) WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- HNSW index for fast L2 nearest-neighbor search (<-> operator)
CREATE INDEX IF NOT EXISTS "user_memories_embedding_vector_idx"
  ON "user_memories" USING hnsw ("embedding_vector" vector_l2_ops)
  WHERE "embedding_vector" IS NOT NULL;
