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

**Webhook-as-executor pattern**

The AI SDK's `execute()` callbacks are not used to run Pipedream tools. Instead the orchestrator returns tool call specs; the webhook runs them, saves the result, and calls `processUserMessage` again with the tool result appended to history. This keeps the execution surface in one place and makes failures observable and retriable.

**Non-blocking critical path**

Memory extraction, embedding, and image blob upload all run in `waitUntil(...)`. The user gets a reply as soon as the AI response is ready; background work continues after the response is sent.

**Reply-quote context**

When a user replies to a previous message on WhatsApp, the quoted message id is resolved via a single Prisma query that joins `messages` and `message_media`. If the original message contained an image, it is fetched from Vercel Blob and passed to the model as a second image attachment.

**Activation-based memory recall**

Memories are ranked by a composite score: vector similarity (pgvector L2 distance) × recency decay × recall frequency. This avoids always surfacing the most recently stored memory and instead surfaces what is most relevant to the current turn.

**Pipedream sub-agent mode**

Every Pipedream MCP tool accepts a single `instruction` string. The orchestrator normalises model outputs that arrive with structured fields (e.g. `{ to, subject, body }`) into the expected `{ instruction: "..." }` shape before passing them to the executor.

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

```bash
# Install dependencies
npm install

# Apply DB migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Run locally
npm run dev
```

**Cron setup**: point any external cron service (e.g. cron-job.org) to `GET /api/cron/tick` every minute with `Authorization: Bearer <CRON_SECRET>`.

**WhatsApp webhook**: set your webhook URL in Meta's developer console to `POST /api/webhook/whatsapp` and use `WHATSAPP_VERIFY_TOKEN` for verification.

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
