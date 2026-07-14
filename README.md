# Context Layer

Context Layer is a canvas-first workspace for teams that turn product knowledge into grounded product decisions, UX artifacts, and interface prototypes. Knowledge, captures, design-system assets, flows, and generated work live together as a connected graph rather than isolated dashboard records.

The current product combines:

- Organization-scoped knowledge ingestion, semantic search, and cited answers
- Infinite project canvases with typed links, notes, frames, comments, checkpoints, restoration, and optimistic layout updates
- Organization sharing plus expiring, revocable, read-only canvas links for external review
- Product capture from a user-invoked Chrome extension, including a redacted DOM outline, screenshot, and ordered flow links
- Context-grounded briefs, flows, UX reviews, interface specifications, and sandboxed prototype previews
- Versioned, manifest-backed design systems with foundations, tokens, components, patterns, and templates
- Read-only MCP access to organization-scoped knowledge, canvases, and design assets
- Confluence and Figma synchronization, plus manual file uploads

## Architecture

This is a Bun/Turborepo monorepo with four active packages:

| Package | Responsibility |
| --- | --- |
| `apps/context-agent` | Hono API, authentication, ingestion, search, connectors, RAG, and ideation endpoints |
| `apps/studio` | Next.js canvas workspace for knowledge, product artifacts, review, and prototypes |
| `apps/capture-extension` | Chrome Manifest V3 extension for user-initiated product captures |
| `packages/db` | Shared Drizzle schema, PostgreSQL access, pgvector support, and migrations |

The main data flow is:

```text
uploads / connectors / product capture / design manifests
                         |
                         v
       extract -> chunk -> filter -> embed -> cite
                         |
                         v
      PostgreSQL + pgvector + immutable artifact revisions
                         |
                         v
                project canvas artifact graph
                         |
                         v
      briefs / flows / UX reviews / specs / prototype previews
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
STUDIO_URL=http://localhost:3000
CONNECTION_ENCRYPTION_KEY=base64-encoded-32-byte-secret
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

### Resource defaults

Local development does not poll external connectors unless `CONNECTOR_POLLING=true` is set. Production polling is serialized, so a slow sync cannot overlap the next interval. Model work is capped at two concurrent requests per API process by default (`MODEL_CONCURRENCY`), preventing bursts of generation from accumulating locally. The Playwright suite uses one worker, owns its temporary API and Studio servers, and disables tracing outside CI to keep laptop CPU, memory, and disk use bounded.

## Canvas workflow

Create a project from Studio, then open it to work on its canvas. The board supports knowledge, capture, design-asset, note, frame, and generated-artifact nodes. Connect nodes with typed relationships, select relevant nodes as AI context, and generate a brief, flow, review, specification, or prototype from the composer.

Files uploaded from a canvas are immediately placed on the board as knowledge nodes. The design-system drawer lists the project-pinned system and can add approved assets as contextual nodes. Generated artifacts can be edited from the selected-artifact panel; every save creates an immutable version entry, and an earlier version can be viewed beside the current one for review. Any revision can also become a separate branch on the canvas while retaining its parent-revision provenance. Canvas history records checkpoints before generation, capture import, context placement, and destructive changes. Restoring a checkpoint brings back the nodes, edges, and comments captured at that point; Context Layer snapshots the pre-restore state first, so restoration itself is recoverable.

### Share and review

Project owners can choose personal, team-scoped, or organization-wide access from the canvas Share panel. They can also issue a read-only review link that expires after 30 days by default. The raw link token is shown once, stored only as a SHA-256 digest, and can be revoked from the same panel. Shared canvases do not expose editing, generation, comments, capture tokens, source drawers, or history controls.

### Product capture extension

Build the extension and load `apps/capture-extension/dist` as an unpacked Chrome extension:

```bash
bun --cwd apps/capture-extension run build
```

In a project canvas, open the context drawer and generate a capture token. Enter the API URL, project ID, and token in the extension options. A click on the extension action captures only the active tab. It excludes form values, password fields, hidden inputs, cookies, local storage, authorization headers, and arbitrary page JavaScript; the server applies a second redaction pass before persisting the capture.

### Design-system manifests

Design-system owners create a system from Studio's `/design-systems` page, submit a validated `DesignManifestV1`, activate a version, and pin that version to a project. A manifest records the package, preview entry, CSS, tokens, foundations, components, patterns, props, variants, examples, accessibility guidance, and source mappings. The first Studio workflow intentionally uses a JSON manifest editor backed by server validation; automated Storybook/package/Figma manifest import remains follow-up work.

### MCP

Create a scoped MCP token with `POST /api/mcp/tokens`, then connect a Streamable HTTP client to `/mcp` with `Authorization: Bearer <token>`. The endpoint currently provides read-only tools for knowledge search, project canvas access, design assets, and source documents. Tokens are organization and user scoped and re-check current membership on every call.

## Common commands

```bash
bun run dev          # Start the API and Studio
bun run build        # Build all active packages
bun run test         # Run fast access-policy and capture-redaction tests
bun run check-types  # Type-check the monorepo
bun run format-lint  # Format and lint with Biome
bun run db:generate  # Generate a Drizzle migration
bun run db:migrate   # Apply database migrations
```

Run the browser canvas workflow with:

```bash
bunx playwright install chromium
bun --cwd apps/studio run test:e2e
```

The Playwright suite starts isolated local API and Studio servers, creates a disposable account and organization, then creates and comments on a canvas project, restores a deleted node from history, and validates anonymous read-only sharing plus revocation.

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
- `/api/projects/*` - Project creation, visibility, canvases, capture tokens, design pinning, and generation
- `/api/canvases/*` - Canvas nodes, edges, comments, layout, and history
- `/api/shared/:token` - Scoped, anonymous read-only canvas access through an active share link
- `/api/design-systems/*` - Manifest-backed design system versions and activation
- `/api/capture/import` - Capture-extension import using a short-lived project token
- `/mcp` - Authenticated Streamable HTTP MCP endpoint

The API derives tenant identity and team membership from Better Auth sessions or verified MCP tokens. Client-supplied organization and user identity are not trusted by the core API routes.

## Current boundaries

This repository is an early product baseline. The current implementation intentionally keeps a few MVP constraints:

- Confluence and Figma connections are organization-scoped; their OAuth tokens are encrypted at rest when `CONNECTION_ENCRYPTION_KEY` is configured.
- Connector updates use periodic polling rather than a durable worker queue or webhooks.
- Text chunking is fixed-size rather than fully structure-aware, and broader media ingestion is not implemented yet.
- Prototypes are self-contained HTML previews in cross-origin-style sandboxed iframes; manifest-validated React file generation and GitHub PR publication remain next-stage work.
- Design-system creation is API-first. Storybook/package bundle extraction, Code Connect import, and Figma library import are not automated yet.
- MCP uses scoped bearer tokens today. OAuth 2.1 discovery, remote-MCP consumption, and write tools are deferred.
- Integration, capture-redaction, concurrency, and tenant-isolation test coverage is still being expanded.

Security, authorization, connector reliability, and data-isolation improvements are the next audit priorities.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
