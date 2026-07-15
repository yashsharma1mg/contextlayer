# AGENTS.md

Guidance for coding agents working in Context Layer.

## Repository

Context Layer is a Bun and Turborepo monorepo:

- `apps/desktop`: Tauri macOS shell and managed local runtimes
- `apps/context-agent`: Hono API, Better Auth, ingestion, jobs, search, generation, GitHub, and MCP
- `apps/studio`: Next.js canvas workspace
- `apps/capture-extension`: Chrome Manifest V3 capture extension
- `packages/db`: Drizzle schema, PostgreSQL/pgvector access, and migrations

## Commands

```bash
bun run dev
bun run build
bun run test
bun run check-types
bun run format-lint
bun run db:generate
bun run db:migrate
bun run --cwd apps/studio test:e2e
bun run --cwd apps/desktop test:resource
```

`bun run build` creates the Apple Silicon app and DMG on macOS. Docker is used only for the development PostgreSQL service; the desktop bundle carries PostgreSQL and pgvector.

## Architecture

- Tenant identity and project roles come only from Better Auth server context.
- Project roles are `owner`, `editor`, and `viewer`.
- Source ACLs fail closed and are applied before retrieval or prompt construction.
- Ingestion runs through the PostgreSQL durable job queue and content-addressed local object storage.
- Search combines PostgreSQL full-text and pgvector ranks and preserves citations.
- Canvas layout is separate from durable source, artifact, capture, and prototype content.
- Design-system versions require a valid `DesignManifestV1`; projects pin one immutable active version.
- React generation must validate assets, props, variants, tokens, citations, and imports before compilation or publication.
- GitHub publication uses local `gh` authentication and explicit owner approval.
- MCP tools enforce OAuth or bearer-token scopes plus current project and source access.

## Local Data

The desktop stores workspace data under `~/Library/Application Support/Context Layer`. Credentials and application secrets belong in macOS Keychain. Never commit `.env` files, tokens, generated desktop bundles, local databases, object files, or backups.

## Quality

- Use strict TypeScript and existing Hono, Drizzle, Zod, React, and React Flow patterns.
- Use Biome for formatting and linting.
- Keep migrations transactional and preserve existing IDs, revisions, comments, and grants.
- Add focused tests for authorization, data integrity, parsing, security boundaries, and lifecycle behavior.
- Keep desktop work bounded: one ingestion job, one model task, and one compilation worker by default.
- Before release, run unit tests, type checks, Biome CI, migrations, Playwright, builds, secret scanning, DMG verification, and the desktop resource gate.
