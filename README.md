# My Padi — AI Personal Assistant on WhatsApp

A production-grade WhatsApp AI assistant that integrates with Gmail, Google Calendar, and 1000+ apps via Pipedream. Users talk to it naturally in their own WhatsApp and it handles email, calendar, reminders, daily briefings, and more. Persistent per-user memory means it gets smarter the more you use it.

---

## What it does

- **Conversational AI over WhatsApp** — users send text, voice, and images; the assistant replies intelligently with full conversation history.
- **Tool use** — sends emails, creates calendar events, and executes actions across 1000+ connected apps via Pipedream Connect MCP.
- **Persistent memory** — learns user preferences, facts, and context across sessions using vector similarity search (pgvector) with an activation-based recall system.
- **Daily morning brief** — at 6:00 AM in the user's local timezone, the assistant sends a personalised rundown of today's calendar events and upcoming reminders.
- **Proactive reminders** — users can set reminders conversationally ("remind me tomorrow at 3pm to call the supplier"); the system delivers them via WhatsApp at the right time in the right timezone.
- **Multimodal input** — handles images (vision), voice notes (transcription via `gpt-4o-transcribe`), and reply-quoted messages with full context including the quoted image.
- **Structured onboarding** — a multi-step signup flow captured by LLM extraction before the user reaches the main assistant.

---

## Architecture overview

```
WhatsApp (user) → Meta Cloud API webhook
                        │
                        ▼
              Next.js API route (Vercel)
                        │
          ┌─────────────┼─────────────┐
          │             │             │
    Media download  Transcription  Blob upload
    (Graph API)     (gpt-4o)       (Vercel Blob)
                        │
                        ▼
               AI Orchestrator
               (gpt-5.2 + tools)
                        │
          ┌─────────────┼──────────────────┐
          │             │                  │
   Pipedream MCP   Native Google     create_reminder
   (1000+ apps)    (Gmail/Calendar)  (Postgres)
                        │
                        ▼
                 Response → sendWhatsAppMessage
                        │
                 Async (waitUntil)
                 ├── Memory extract + embed (gpt-4o-mini, text-embedding-3-small)
                 └── Blob upload for image context (reply-quote support)
```

**Cron tick** (`/api/cron/tick`, runs every minute via cron-job.org):
- Delivers due reminders to the right users via WhatsApp.
- Sends the morning brief at 6:00 AM per-user local timezone.

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime / hosting | [Next.js 14](https://nextjs.org) on [Vercel](https://vercel.com) (Fluid Compute, `maxDuration: 300s`) |
| Messaging channel | [Meta WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) (direct, no BSP) |
| AI — main chat | OpenAI `gpt-5.2` via [Vercel AI SDK](https://sdk.vercel.ai) |
| AI — extraction / mini tasks | OpenAI `gpt-4o-mini` |
| AI — voice transcription | OpenAI `gpt-4o-transcribe` |
| AI — memory embeddings | OpenAI `text-embedding-3-small` (1536-dim) |
| Memory store | PostgreSQL + `pgvector` (vector similarity search) via Supabase |
| Database ORM | [Prisma](https://www.prisma.io) with `@prisma/adapter-pg` |
| Integrations | [Pipedream Connect MCP](https://pipedream.com/connect) — 1000+ apps in sub-agent mode |
| Native integrations | Google OAuth 2.0, Gmail API, Google Calendar API |
| Media storage | [Vercel Blob](https://vercel.com/docs/vercel-blob) — inbound images stored for reply-quote context |
| Schema validation | [Zod](https://zod.dev) |
| Timezone handling | [date-fns-tz](https://github.com/marnusw/date-fns-tz), [libphonenumber-js](https://gitlab.com/catamphetamine/libphonenumber-js) |

---

## Project structure

```
.
├── app/
│   └── api/
│       ├── webhook/whatsapp/     # Main inbound message handler (POST) + webhook verification (GET)
│       ├── cron/tick/            # Single cron endpoint: reminders + morning brief
│       └── connect/              # OAuth callback routes (Google, Pipedream)
│
├── lib/
│   ├── ai/
│   │   ├── orchestrator.ts       # Core AI loop: message history, tool schema, generateText
│   │   ├── extract-signup-data.ts
│   │   └── extract-calendar-event.ts
│   │
│   ├── memory/
│   │   ├── store.ts              # pgvector search, retain (upsert + embed), markRecalled
│   │   ├── extract.ts            # LLM-based memory candidate extraction (gpt-4o-mini)
│   │   ├── embed.ts              # text-embedding-3-small wrapper
│   │   ├── activation.ts         # Activation scoring: relevance × recency × frequency
│   │   ├── index.ts              # Public API: getMemoriesForTurn, retain, markRecalled
│   │   └── types.ts
│   │
│   ├── channels/whatsapp/
│   │   ├── client.ts             # sendWhatsAppMessage, sendTypingIndicator
│   │   └── media.ts              # downloadWhatsAppMedia (two-step Graph API fetch)
│   │
│   ├── mcp/
│   │   ├── pipedream-client.ts   # MCP client init, one client per connected app
│   │   ├── pipedream-auth.ts     # Pipedream SDK backend client + access token
│   │   ├── tool-executor.ts      # Routes tool calls to correct Pipedream app
│   │   └── calendar-list-via-proxy.ts  # Direct Google Calendar API proxy (list + create)
│   │
│   ├── google/
│   │   ├── oauth.ts              # Google OAuth 2.0 PKCE flow (no googleapis dependency)
│   │   ├── gmail.ts              # Gmail REST API wrappers
│   │   └── calendar.ts           # Google Calendar REST API wrappers
│   │
│   ├── cron/
│   │   ├── run-morning-brief.ts  # Morning brief logic (6am per-TZ, calendar + reminders)
│   │   └── run-deliver-reminders.ts
│   │
│   ├── reminders/
│   │   ├── create.ts
│   │   └── calendar-nudges.ts    # Auto-creates 5min + 15min pre-event reminders
│   │
│   ├── db/                       # Prisma-backed DB helpers (users, messages, conversations, etc.)
│   ├── connect/                  # Pipedream Connect link generation
│   ├── config/                   # Feature flags (e.g. isPipedreamEnabled)
│   └── context/                  # Timezone + country inference from phone number
│
└── prisma/
    ├── schema.prisma             # Full DB schema: User, Conversation, Message, MessageMedia,
    │                             # UserMemory, Reminder, AppConnection, Subscription, SignupState
    └── migrations/
```

---

## Key design decisions

### Memory system

The assistant maintains a long-term, per-user knowledge base that survives across sessions — not just the last N messages in context.

**Extraction**

After every turn, `gpt-4o-mini` reads the user message and assistant reply and outputs only what is *new or changed* about the user — facts, preferences, beliefs, relationships, commitments, or notable experiences. Crucially, each memory is given a stable semantic key (e.g. `fact_employer`, `preference_meeting_time`). If the user says "actually I moved to London" the model outputs the same key as the existing `fact_location` entry — so the upsert overwrites it rather than creating a duplicate. Greetings, one-off chit-chat, and anything already stored unchanged are explicitly discarded.

**Storage**

Each retained memory is embedded with `text-embedding-3-small` (1536 dimensions) and upserted via Prisma with a `(userId, key)` unique constraint. The embedding is then written to a separate `embedding_vector` column (pgvector type) via raw SQL, which is the column used for nearest-neighbour search.

**Two-phase retrieval**

At the start of each turn, the user's message is embedded and used to query the database:

1. **Candidate fetch**: pgvector returns the top 300 memories by L2 distance (nearest neighbours by meaning).
2. **Re-rank by activation**: each candidate is scored with `0.6 × relevance + 0.2 × recency + 0.2 × frequency`. Relevance comes from the vector distance; recency is `1 / (1 + days_since_last_recall)` — it decays fast for rarely touched memories; frequency is `ln(1 + recallCount) / ln(101)` capped at 1.
3. **Token budget**: the top 20 by activation score are walked in order and added to the prompt until an 800-token budget is exhausted.

**Natural forgetting**

There is no explicit delete step. A memory that was written once and never recalled again will have a low recency score and zero frequency score. Its `activation_baseline` (stored on the row and updated on every upsert and recall) will decay toward zero over days and weeks. It will lose out to more relevant or frequently recalled memories in the re-rank step and stop appearing in context — effectively forgotten without ever being deleted. If the user brings it up again, it resurfaces naturally.

**markRecalled**

Every time a set of memories makes it into the prompt, their `lastRecalledAt` timestamp and `recallCount` are updated in the background (via `waitUntil`). This raises their activation baseline, so genuinely useful memories stay visible while one-off facts fade.

---

### Webhook-as-executor pattern

The AI SDK's `execute()` callbacks are not used to run Pipedream tools. Instead the orchestrator returns tool call specs; the webhook runs them, saves the result, and calls the AI again with the tool result appended to history. This keeps the execution surface in one place and makes failures observable and retriable without any hidden side effects inside the model loop.

---

### Non-blocking critical path

Memory extraction, embedding writes, `markRecalled`, and image blob upload all run inside Vercel's `waitUntil(...)`. The user receives a reply as soon as the AI response arrives; all background work runs after the HTTP response is sent. This keeps perceived latency low regardless of how many memories are being processed.

---

### Reply-quote context

When a user replies to a previous message on WhatsApp, the quoted message ID is resolved in a single Prisma query that joins `messages` and `message_media`. If the original message contained an image, it is fetched from Vercel Blob and passed to the model as a second image attachment alongside the current message. This means the model always has the full visual context for follow-up questions like "what did I mean by this?".

---

### Timezone-aware scheduling

Every user's timezone is inferred at signup from their phone number's country code (via `libphonenumber-js`). Reminders and the morning brief are stored and evaluated against the user's local time. The single `/api/cron/tick` endpoint runs every minute and checks whether it is currently 6:00 AM for each user — no per-user cron jobs, no queue, no worker processes.

---

### Multi-round tool loop

The AI is not called once per user message. The webhook runs a loop (capped at 3 rounds): call the AI → if it returns tool calls, execute them, save results, reload conversation history, call the AI again. This continues until the model returns a plain text response. It handles real-world sequences like "search for connectable apps → pick one → send a connect link" without any special orchestration layer.

---

### Dual-mode integration (Pipedream vs native Google)

The integration layer has two modes controlled by a single environment variable (`PIPEDREAM_STATE`):

- **Pipedream mode** (default): initialises an MCP client per user, loads all tools from their connected apps, and adds `search_connectable_apps` and `send_connection_link` to let users self-serve new connections during a conversation.
- **Native mode**: uses hand-written wrappers for Gmail and Google Calendar only. No MCP, no Pipedream SDK, no external dependency at runtime. Useful for constrained deployments or cost control.

The switch is one line in `lib/config/integrations.ts`. The rest of the webhook and orchestrator work the same in both modes.

---

### Onboarding state machine

New users go through a two-step signup before reaching the main assistant: email → name. State is stored in a `signup_states` table (keyed by phone number) and cleared on completion. Each step uses AI extraction (`gpt-4o-mini`) to pull structured data from natural language (e.g. "I'm John" → name: "John"), with Zod validation as the final gate before writing to the database.

---

### Calendar nudge reminders

When a calendar event is created via the native Google Calendar path, the system automatically creates two additional WhatsApp reminders in the background (`waitUntil`): one 15 minutes before the event and one 5 minutes before. The user gets a WhatsApp ping before each meeting without having to ask for it.

---

### Recurrence guard

The Google Calendar API defaults to creating recurring events if the AI model includes recurrence fields. A normalisation step in the webhook (`normalizeCalendarCreateEventInstruction`) appends an explicit no-recurrence instruction to any calendar create tool call where the user did not ask for a repeating event. This prevents a common failure mode where the model over-generates and creates an unintended daily or weekly series.

---

### Pipedream sub-agent mode

Every Pipedream MCP tool accepts a single `instruction` string. The orchestrator normalises model outputs that arrive with structured fields (e.g. `{ to, subject, body }`) into the expected `{ instruction: "..." }` shape before passing them to the executor. This keeps the tool interface uniform across 1000+ apps without needing per-app schemas.

---

## Environment variables

```env
# OpenAI
OPENAI_API_KEY=

# WhatsApp Cloud API (direct)
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=

# Database
DATABASE_URL=                     # Postgres connection string (Supabase)

# Vercel Blob
BLOB_READ_WRITE_TOKEN=

# Pipedream Connect
PIPEDREAM_CLIENT_ID=
PIPEDREAM_CLIENT_SECRET=
PIPEDREAM_PROJECT_ID=
PIPEDREAM_ENVIRONMENT=            # "production" | "development"
PIPEDREAM_STATE=                  # set to "false" to disable Pipedream and use native Google only

# Google OAuth (native mode)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Cron
CRON_SECRET=                      # Bearer token checked by /api/cron/tick

# Optional
MEMORY_ENABLED=true               # set to "false" to disable the memory subsystem
```

---

## Getting started

### 1. Install and run locally

```bash
npm install
npx prisma migrate deploy
npx prisma generate
npm run dev
```

### 2. WhatsApp Business setup (Meta)

This project uses the **WhatsApp Business Cloud API** directly (no third-party BSP).

**Prerequisites**
- A [Meta Developer account](https://developers.facebook.com)
- A Facebook Business account verified with Meta
- A WhatsApp Business Account (WABA) and a dedicated phone number

**Steps**

1. Go to [developers.facebook.com](https://developers.facebook.com) → Create App → Business type.
2. Add the **WhatsApp** product to your app.
3. Under *WhatsApp → API Setup*, note your:
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary or permanent access token** → `WHATSAPP_ACCESS_TOKEN`
4. Under *WhatsApp → Configuration*, set your webhook:
   - **Callback URL**: `https://your-domain.vercel.app/api/webhook/whatsapp`
   - **Verify token**: any string you choose → `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **`messages`** webhook field.
5. To send messages beyond the test number, submit your app for Meta Business Verification and request the `whatsapp_business_messaging` permission.

> The webhook GET handler in `app/api/webhook/whatsapp/route.ts` handles the Meta verification handshake automatically using `WHATSAPP_VERIFY_TOKEN`.

### 3. Supabase (Postgres + pgvector)

1. Create a new project at [supabase.com](https://supabase.com).
2. Enable the `pgvector` extension: in the Supabase SQL editor run:
   ```sql
   create extension if not exists vector;
   ```
3. Copy your connection string (Project Settings → Database → Connection string → URI) → `DATABASE_URL`.
4. Run migrations: `npx prisma migrate deploy`.

### 4. Pipedream Connect (app integrations)

1. Create a project at [pipedream.com](https://pipedream.com).
2. Go to *Connect → Your Project* and copy:
   - **Client ID** → `PIPEDREAM_CLIENT_ID`
   - **Client Secret** → `PIPEDREAM_CLIENT_SECRET`
   - **Project ID** → `PIPEDREAM_PROJECT_ID`
3. Set `PIPEDREAM_ENVIRONMENT=production` for live use.
4. To disable Pipedream and use only the native Google integration, set `PIPEDREAM_STATE=false`.

### 5. Cron (reminders + morning brief)

Point any cron service that can call an HTTP endpoint (e.g. [cron-job.org](https://cron-job.org), free) to:

```
GET https://your-domain.vercel.app/api/cron/tick
Authorization: Bearer <CRON_SECRET>
```

Run it **every minute**. The handler checks each user's timezone and fires the morning brief only when it is 6:00 AM local time for that user, so a per-minute trigger is sufficient and cheap.

---

## Database schema (summary)

| Table | Purpose |
|---|---|
| `users` | Phone number, name, subscription tier, last morning brief timestamp |
| `conversations` | One per user; anchor for message history |
| `messages` | Full message history: `user`, `assistant`, `tool`, `system` roles |
| `message_media` | Inbound images linked to a message (for reply-quote image context) |
| `user_memories` | Per-user memory slots with `pgvector` embeddings and activation metadata |
| `reminders` | Scheduled reminders with status tracking and IANA timezone |
| `app_connections` | OAuth tokens and Pipedream connection IDs per user per app |
| `subscriptions` | Subscription tier records |
| `signup_states` | Ephemeral multi-step onboarding state machine |
