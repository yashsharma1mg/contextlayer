# Context Layer

Context Layer is a team knowledge workspace. It collects internal context from the tools a team already uses, makes that context searchable, and uses it to answer questions and develop product ideas.

The current product combines:

- Organization-scoped knowledge ingestion and semantic search
- RAG answers with source citations
- Confluence and Figma synchronization
- Collaborative product projects and comments
- Context-grounded concept briefs
- Context-grounded single-file UI mockups

## Architecture

This is a Bun/Turborepo monorepo with three active packages:

| Package | Responsibility |
| --- | --- |
| `apps/context-agent` | Hono API, authentication, ingestion, search, connectors, RAG, and ideation endpoints |
| `apps/studio` | Next.js workspace for login, knowledge questions, projects, ideas, and collaboration |
| `packages/db` | Shared Drizzle schema, PostgreSQL access, pgvector support, and migrations |

The main data flow is:

```text
Confluence / Figma / uploads
              |
              v
     extract -> chunk -> filter -> embed
              |
              v
       PostgreSQL + pgvector
              |
              v
       search -> cite -> answer
              |
              v
       concepts and UI mockups
```

Embeddings use NVIDIA NIM's `nvidia/nv-embedqa-e5-v5` model. Chat, concept generation, and UI generation use OpenRouter through an OpenAI-compatible client.

## Local setup

### Requirements

- Bun `1.3.6`
- Node.js `20` or newer
- Docker, for the local PostgreSQL/pgvector database
- API credentials for embeddings and model generation

### Install dependencies

```bash
bun install
```

### Start PostgreSQL

```bash
docker compose up -d db
```

The database is exposed on port `5433` and includes the pgvector extension.

### Configure the API

```bash
cp apps/context-agent/.env.example apps/context-agent/.env
```

Set at least these values in `apps/context-agent/.env`:

```dotenv
DATABASE_URL=postgres://postgres:postgres@localhost:5433/contextlayer
BETTER_AUTH_SECRET=replace-with-a-long-random-secret
BETTER_AUTH_URL=http://localhost:8787
NVIDIA_API_KEY=your-nvidia-key
OPENROUTER_API_KEY=your-openrouter-key
```

Confluence and Figma OAuth values are required only when using those connectors. Their callback URLs are listed in the example environment file.

### Configure Studio

```bash
cp apps/studio/.env.example apps/studio/.env.local
```

For local development, the default API URL is `http://localhost:8787`.

### Apply database migrations

```bash
bun run db:migrate
```

### Start development

```bash
bun run dev
```

Studio runs on the Next.js development port and the API runs on port `8787`.

## Common commands

```bash
bun run dev          # Start the API and Studio
bun run build        # Build all active packages
bun run check-types  # Type-check the monorepo
bun run format-lint  # Format and lint with Biome
bun run db:generate  # Generate a Drizzle migration
bun run db:migrate   # Apply database migrations
```

## Product workflows

### Ask the knowledge base

Studio sends a question to the API. The API searches organization-visible, team-visible, and personal memories, then generates an answer with the retrieved documents as sources.

### Add knowledge

Knowledge can enter through:

- Manual file uploads for supported text and PDF files
- Confluence OAuth and periodic page synchronization
- Figma OAuth and watched-file synchronization

All sources use the same ingestion pipeline: extraction, chunking, signal filtering, embedding, and pgvector storage.

### Develop product ideas

Projects provide a shared workspace for product exploration. A prompt can generate either:

- A concept brief with a summary, key flows, and open questions
- A single-file HTML/Tailwind UI mockup rendered in Studio

Generated ideas retain references to the knowledge documents used for grounding, and teammates can comment on them.

## API surface

The API is served by `apps/context-agent`:

- `/health` - Health check
- `/api/auth/*` - Better Auth endpoints
- `/api/memories` - Document ingestion and file uploads
- `/api/memories/search` - Semantic memory search
- `/api/ask` - Context-grounded questions and answers
- `/api/connections/*` - Confluence and Figma OAuth, status, watching, and sync
- `/api/projects/*` - Project creation, visibility, ideas, and comments

The API is an internal pilot surface. Authentication and server-derived tenant identity are active follow-up work before broader multi-tenant use.

## Current boundaries

This repository is an early product baseline. The current implementation intentionally keeps a few MVP constraints:

- Confluence and Figma connections are organization-scoped.
- Connector updates use periodic polling rather than webhooks.
- Text chunking is fixed-size rather than structure-aware.
- Generated UI artifacts are single HTML documents rendered in sandboxed iframes.
- Integration and tenant-isolation test coverage is still being expanded.

Security, authorization, connector reliability, and data-isolation improvements are the next audit priorities.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
