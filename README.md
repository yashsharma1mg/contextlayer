# Context Layer

Context Layer is a local-first, canvas-based workspace for turning product knowledge into grounded decisions, UX artifacts, and validated React prototypes. Documents, product captures, design-system assets, flows, requirements, reviews, and generated interfaces live together as a connected project graph.

The first release is a standalone Apple Silicon macOS application. Workspace data stays on the Mac. Remote AI and connector services receive data only for an action the user has configured and consented to.

## What it does

- Organizes team knowledge on infinite project canvases with typed relationships, frames, comments, mentions, checkpoints, branching, comparison, and restoration.
- Imports files, URLs, product captures, GitHub, Notion, Google Drive, Slack, Confluence, Figma, and explicitly allowlisted remote MCP resources.
- Extracts text and provenance from text, Markdown, HTML, JSON, CSV, PDF, DOCX, PPTX, XLSX, images, audio, and video.
- Combines PostgreSQL full-text and pgvector retrieval, preserves source access rules, and cites the evidence used by answers and artifacts.
- Records multi-step product flows through a Chrome extension with a local redaction preview before upload.
- Imports package metadata, browser bundles, CSS, Storybook, read-only Figma libraries and variables, and Code Connect mappings into versioned design manifests.
- Generates briefs, requirements, flows, state matrices, UX reviews, interface specifications, tests, and multi-file React prototypes.
- Validates generated React against the project's pinned design-system version before compiling or publishing it.
- Publishes approved prototypes through the locally authenticated GitHub CLI without copying or storing GitHub credentials.
- Exposes an OAuth 2.1 and scoped-token Streamable HTTP MCP server for approved knowledge, canvas, design, generation, and publication operations.

## Architecture

This is a Bun and Turborepo monorepo with five active packages:

| Package | Responsibility |
| --- | --- |
| `apps/desktop` | Tauri macOS shell, managed local runtimes, lifecycle, backup, restore, and DMG packaging |
| `apps/context-agent` | Hono API, Better Auth, ingestion, search, connectors, jobs, generation, GitHub publication, and MCP |
| `apps/studio` | Next.js canvas workspace for knowledge, product reasoning, review, and prototypes |
| `apps/capture-extension` | Chrome Manifest V3 product capture and local redaction preview |
| `packages/db` | Drizzle schema, PostgreSQL and pgvector access, and transactional migrations |

```text
files / URLs / connectors / capture / design sources
                         |
                         v
       durable jobs -> extract -> provenance -> chunk
                         |
                         v
        PostgreSQL full-text + pgvector + local objects
                         |
                         v
             ACL-filtered project canvas graph
                         |
                         v
      cited reasoning -> validated UI plan -> React files
                         |
                         v
          sandboxed preview -> explicit GitHub approval
```

## macOS application

### Install

The packaging target is Apple Silicon macOS 13 or newer. Build artifacts are written to:

```text
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/
```

Open the DMG, drag Context Layer to Applications, and launch it. The bundle includes PostgreSQL 17 with pgvector, the API, the production Studio runtime, the prototype compiler, and the media extractor. Docker, Node.js, Bun, and a separately installed database are not required at runtime.

Unsigned development builds are ad-hoc signed and may require approval in macOS Privacy & Security. Public distribution requires an Apple Developer ID signature and notarization.

### Local data

Context Layer stores its runtime data under:

```text
~/Library/Application Support/Context Layer
```

| Directory | Contents |
| --- | --- |
| `database/` | Local PostgreSQL cluster and vector indexes |
| `objects/` | Content-addressed originals and derived media |
| `backups/` | Automatic database backups created before startup migrations |
| `logs/` | PostgreSQL, API, and Studio logs |
| `run/` | Local database socket files |

Connector credentials and application secrets are stored in macOS Keychain, not in the data directory. Removing the application does not delete workspace data.

To inspect the folder from Terminal:

```bash
open "$HOME/Library/Application Support/Context Layer"
```

### Backup and restore

The desktop runtime creates a timestamped PostgreSQL dump before applying migrations to an existing database. To restore one of those dumps:

1. Quit Context Layer.
2. Write the absolute path of a `.dump` file from the `backups` directory to `~/Library/Application Support/Context Layer/restore-request`.
3. Relaunch Context Layer.

The runtime accepts restore files only from its own backup directory, restores before migrations, and removes the request marker after success. Keep a separate copy of the entire Context Layer data directory for device-level backup.

### Resource policy

The desktop uses local-only ports and sockets, caps PostgreSQL memory, runs one durable ingestion job at a time, disables automatic connector polling by default, limits model concurrency to one, and starts compilation workers only on demand. Quitting the application terminates the API, Studio, PostgreSQL, compiler, media helpers, and their process groups.

The release gate on an 8 GB Apple Silicon Mac is under 2% settled idle CPU, under 750 MB total idle memory, and no surviving child processes after quit.

## Privacy and consent

Workspace records, object files, search indexes, generated files, revisions, and backups are local by default. Context Layer shows the selected provider and data boundary before sending content to a remote service for embeddings, image description, transcription, or generation. Consent is recorded per organization, provider, capability, and policy version and can be revoked.

The local runtime binds Studio, the API, and PostgreSQL to `127.0.0.1`. External connector principals must map to a local user, team, or organization grant; unmapped access fails closed. Project roles are:

- `owner`: membership, settings, design pinning, approval, and publication
- `editor`: canvas and artifact changes, imports, and generation
- `viewer`: reading and comments

The capture extension never collects cookies, local storage, authorization headers, password values, hidden inputs, arbitrary scripts, or inaccessible cross-origin frame contents. Form values are masked by default and the capture is shown locally for redaction before upload.

## Knowledge and connectors

Supported local inputs are plain text, Markdown, HTML, JSON, CSV, PDF, DOCX, PPTX, XLSX, common images, audio, and video. Extraction preserves the applicable page, slide, sheet, URL, timestamp, frame, connector, and source-revision provenance. HTML scripts and styles are ignored. Media processing is bounded and runs through the bundled macOS helper; remote descriptions or transcripts require provider consent.

Connectors support initial and incremental synchronization, cursor persistence, deletions, cancellation, retries, rate limits, expired credentials, and revoked access:

- GitHub repositories
- Notion workspaces
- Google Drive
- Slack
- Confluence
- Figma files and read-only libraries
- Allowlisted Streamable HTTP MCP servers
- Web URLs

Connector sync is manual by default in the desktop release. Remote MCP must use HTTP or HTTPS, match `OUTBOUND_MCP_ALLOWLIST`, remain on its original allowlisted origin, and cannot redirect to or resolve as a private-network address.

Search uses structure-aware chunks and reciprocal-rank fusion across PostgreSQL full-text and pgvector rankings. Every result is filtered through organization, team, user, project, and source grants before it reaches a prompt. Answers and generated artifacts require citations; selecting one focuses its source node on the canvas.

## Canvas workflow

Each project starts with a default infinite canvas. Nodes reference durable sources and artifacts while keeping position and presentation separate from content. Supported artifacts include briefs, requirements, user flows, state matrices, UX reviews, interface specifications, test cases, and React prototypes. Edges can be `derived_from`, `supports`, `contradicts`, `flows_to`, `implements`, or `references`.

Edits autosave with optimistic object versions. Changes to different objects merge independently; conflicting changes to the same object return a visible conflict. Context Layer checkpoints before imports, generation, regeneration, deletion, and restoration. Artifact revisions are immutable and retain authorship, citations, generation inputs, design-system version, and parent revision.

Projects support member roles, organization sharing, node comments, mentions, resolution, and expiring revocable read-only links. Live cursors and networked multiplayer are intentionally deferred.

## Product capture

Build the extension and load `apps/capture-extension/dist` as an unpacked Chrome extension:

```bash
bun run --cwd apps/capture-extension build
```

Create a short-lived capture token from a project, then enter the local API URL, project ID, and token in the extension options. Start a flow to capture ordered steps. Each accepted step stores its sanitized outline and screenshot through encrypted local object storage, creates a canvas node, indexes safe visible text, and links the sequence with `flows_to` edges. Processing state and failures appear on the node.

## Design-system intelligence

A design-system version cannot be activated until it has a valid `DesignManifestV1`. Imports create drafts and preserve source and validation provenance. Owners resolve validation issues and merge conflicts before activation; every project pins exactly one immutable active version.

The manifest can include package imports, browser and CSS entries, foundations, tokens, primitives, components, patterns, templates, props, variants, slots, examples, accessibility guidance, composition constraints, and source mappings. Importers support package metadata and browser-compatible archives, Storybook, read-only Figma libraries and variables, and Code Connect mappings. Package inspection blocks install scripts, path traversal, executable macros, unbounded archive expansion, arbitrary network access, and known unbounded execution patterns.

Design assets can be searched and placed on the canvas as context. The canvas is an artifact graph, not a vector editor or low-level component layout tool.

## Reasoning and React generation

The composer routes prompts to research synthesis, product briefs, requirements, flow mapping, state matrices, edge-case review, interface specifications, tests, or React generation. Before interface generation, the reasoning layer covers permissions, loading, empty, validation, error, retry, quota, and recovery states.

An interface specification contains a structured `UiPlan` with approved asset IDs, imports, props, variants, tokens, navigation, screen states, citations, file structure, target framework, and pinned manifest version. Context Layer rejects invented assets or missing citations before generating multi-file React and TypeScript for Vite or Next.js.

Compilation runs in one short-lived worker. Preview output is served in a sandboxed cross-origin iframe without same-origin access, storage, top-level navigation, or network access by default. Compilation or manifest validation failures block approval and publication.

## GitHub publication

Publication uses the locally installed and authenticated `gh` CLI and never reads or stores its credentials. A project owner configures the repository, base branch, framework, app root, package manager, allowed paths, and design-system import. Context Layer validates repository access and file boundaries before showing a publication preview.

Only an explicit in-product owner approval starts publication. Approved files are written to a `contextlayer/<project>-<artifact>` branch and a pull request is opened with validation results, citations, artifact references, and design-system provenance. Every attempt has a durable publication audit.

## MCP

The API serves Streamable HTTP MCP at `/mcp` and publishes OAuth 2.1 discovery metadata under `/.well-known/`. Clients can use Better Auth OAuth access tokens or revocable local bearer tokens created through `/api/mcp/tokens`.

Available scopes are enforced per tool:

- `knowledge:read`
- `canvas:read`
- `design:read`
- `artifacts:write`
- `generation:write`
- `publication:write`

Tools cover knowledge search, project canvases, artifacts, design assets, validated UI planning and React generation, and approval-gated publication. Project roles and source ACLs are rechecked on every operation; a token scope never grants a role the user does not already hold.

## Development

### Requirements

- macOS for the desktop and DMG target
- Bun `1.3.6`
- Node.js 20 or newer for development tooling
- PostgreSQL with pgvector, or Docker for the development database only
- Rust and Xcode command-line tools for the Tauri bundle

Install dependencies and configure development services:

```bash
bun install
docker compose up -d db
cp apps/context-agent/.env.example apps/context-agent/.env
cp apps/studio/.env.example apps/studio/.env.local
bun run db:migrate
bun run dev
```

The development API defaults to `http://localhost:8787`; Studio defaults to `http://localhost:3000`. Configure only the remote providers you intend to use. Provider consent is still required in the product before content is sent.

### Commands

```bash
bun run dev                    # Start development applications
bun run build                  # Build all packages, including the DMG on macOS
bun run test                   # Run package unit tests
bun run check-types            # Type-check the monorepo
bun run format-lint            # Format and lint with Biome
bun run db:generate            # Generate a Drizzle migration
bun run db:migrate             # Back up and apply migrations
bun run --cwd apps/studio test:e2e # Run the browser workflow
```

The Playwright workflow creates an isolated account and organization, imports and indexes a redacted product capture, verifies encrypted screenshot access and search, exercises comments and history restoration, and checks read-only sharing and revocation.

### Development environment

`apps/context-agent/.env.example` documents database, Better Auth, encryption, model, connector, and OAuth values. At minimum, development requires `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `STUDIO_URL`, and `CONNECTION_ENCRYPTION_KEY`. NVIDIA and OpenRouter credentials are required only for their corresponding remote model operations.

The production desktop creates its own secrets in macOS Keychain and supplies its bundled runtime paths automatically. Do not place credentials in committed files.

## API surface

- `/health` and `/health/desktop` - process and desktop runtime health
- `/api/auth/*` - Better Auth and OAuth provider endpoints
- `/api/memories` and `/api/memories/search` - ingestion and ACL-filtered retrieval
- `/api/ask` - cited knowledge answers
- `/api/connections/*` - connector setup, status, synchronization, and cursors
- `/api/jobs/*` - durable job status, progress, retry, and cancellation
- `/api/privacy/*` - provider policy and consent
- `/api/projects/*` and `/api/canvases/*` - memberships, sharing, nodes, edges, comments, artifacts, and history
- `/api/design-systems/*` - manifests, imports, validation, activation, and project pinning
- `/api/capture/*` - capture token and redacted flow ingestion
- `/api/publication/*` - validation preview, explicit approval, and publication audits
- `/mcp` - authenticated Streamable HTTP MCP endpoint

Tenant, team, user, and role identity come from authenticated server context. Core APIs do not trust client-supplied identity.

## Current boundaries

- The first release is single-device and local-first. Cloud sync, networked multiplayer, and live cursors are deferred.
- Figma is an input only; editable Figma export is deferred.
- The canvas organizes evidence and generated artifacts but does not provide vector drawing or low-level component editing.
- Remote AI remains optional but local embedding and generation models are not bundled in this release.
- Connector synchronization is manual by default; webhooks and continuous background sync are deferred.
- The generated DMG must be signed and notarized with Apple Developer credentials before public distribution. Development builds are ad-hoc signed for local testing.

## License

Context Layer is licensed under the MIT License. See [LICENSE](LICENSE).
