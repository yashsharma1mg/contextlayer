<div align="center">

# Context Layer

**A local-first macOS workspace that turns scattered product knowledge into cited decisions and compilable React, with the evidence attached.**

[![CI](https://github.com/Yasharma117/contextlayer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Yasharma117/contextlayer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%2013%2B%20·%20Apple%20Silicon-lightgrey)

[What it does](#what-it-does) · [Workflow](#primary-workflow) · [Why](#why-its-built-this-way) · [Verification](#verification) · [Boundaries](#current-boundaries) · [Privacy](#privacy-and-consent) · [Quick start](#quick-start)

</div>

---

Documents, product captures, design-system assets, flows, requirements, reviews, and generated interfaces live together as a connected project graph. Every answer cites its sources. Every generated interface is validated against a pinned design-system version before a single file is emitted.

The first release is a standalone Apple Silicon macOS application. Workspace data stays on the Mac. Remote AI and connector services receive data only for an action the user has configured and consented to.

## What it does

- Organizes project knowledge on **infinite canvases** with typed relationships, frames, comments, mentions, checkpoints, branching, comparison, and restoration.
- Imports files, URLs, product captures, GitHub, Notion, Google Drive, Slack, Confluence, Figma, and explicitly allowlisted remote MCP resources.
- Extracts text and provenance from text, Markdown, HTML, JSON, CSV, PDF, DOCX, PPTX, XLSX, images, audio, and video.
- Combines PostgreSQL full-text and pgvector retrieval, preserves source access rules, and **cites the evidence** used by answers and artifacts.
- Records multi-step product flows through a Chrome extension with a **local redaction preview** before upload.
- Imports package metadata, browser bundles, CSS, Storybook, read-only Figma libraries and variables, and Code Connect mappings into versioned design manifests.
- Generates briefs, requirements, flows, state matrices, UX reviews, interface specifications, tests, and multi-file React prototypes.
- **Validates generated React** against the project's pinned design-system version before compiling or publishing it.
- Publishes approved prototypes through the locally authenticated GitHub CLI without copying or storing GitHub credentials.
- Exposes an OAuth 2.1 and scoped-token Streamable HTTP MCP server for approved knowledge, canvas, design, generation, and publication operations.

## Primary workflow

**1. Bring in product evidence.** Drop in files and URLs, sync GitHub, Notion, Drive, Slack, Confluence, or Figma, and record real product flows with the Chrome extension. Every item keeps its page, slide, sheet, timestamp, frame, and source-revision provenance, and captures are shown locally for redaction before anything uploads.

**2. Ask questions and receive cited decisions.** Retrieval fuses PostgreSQL full-text and pgvector ranking, filtered through organization, user, project, and source grants *before* it reaches a prompt. Answers and generated artifacts carry citations; selecting one focuses its source node on the canvas.

**3. Generate validated React.** An interface specification becomes a structured `UiPlan` pinned to the project's design-system version. An unapproved component, prop, variant, or token — or a citation the caller cannot actually read — fails the request outright, so no file is ever emitted from an unverifiable plan.

**4. Publish through controlled GitHub access.** An owner reviews the validation preview and approves explicitly. Approved files land on a `contextlayer/<project>-<artifact>` branch behind a pull request carrying validation results, citations, artifact references, and design-system provenance, published through your already-authenticated `gh` CLI.

## Why it's built this way

The hard part of a knowledge tool is not retrieval. It is making sure the thing it hands you can be trusted and traced. Five decisions follow from that:

| Decision | Reason |
| --- | --- |
| Unmapped connector access **fails closed** | An access bug in a knowledge tool surfaces the wrong document silently. Failing closed turns a silent leak into a visible error |
| Generation **rejects unapproved assets and unreadable citations before any file is emitted** | An interface that cites nothing cannot be reviewed, only accepted on faith. Rejecting at plan time means there is no half-valid output to talk yourself into shipping |
| Each project pins **exactly one immutable design-system version** | Generated React cannot drift from the system it claims to implement if the manifest is frozen at generation time |
| Approval is **bound to exactly what was reviewed** | An approval token carries the artifact, file set, repository, and approver. If the files change after review, publication fails rather than shipping something nobody approved |
| Publication runs through the **locally authenticated `gh` CLI**, storing no credentials | The tool never holds a secret it does not need to hold |

Retrieval is filtered through organization, user, project, and source grants **before it reaches a prompt** — not after. Artifact revisions are immutable and retain authorship, citations, generation inputs, design-system version, and parent revision. The canvas is an artifact graph, not a vector editor.

Where enforcement would be dishonest, it is advisory instead. Screen-state coverage — permission, loading, empty, validation, error, retry, quota, recovery — is surfaced as advice rather than a hard block, because a perfectly good settings screen does not necessarily have a quota state. Only design-system integrity and citation access hard-fail.

## Verification

Claims in this README are checkable without installing anything.

| Claim | Where to check it |
| --- | --- |
| **CI is real, not decorative** | The badge above. [`ci.yml`](.github/workflows/ci.yml) chains seven gates: frozen-lockfile install, migrations against a live `pgvector/pgvector:pg17` service, Biome, type-check, unit tests, build, then a Playwright browser workflow |
| **Risk seams are tested, not just happy paths** | 15 unit suites, sitting deliberately on the dangerous edges: [`access-policy`](apps/context-agent/src/lib/access-policy.test.ts) · [`mcp-scopes`](apps/context-agent/src/lib/mcp-scopes.test.ts) · [`capture-redaction`](apps/context-agent/src/lib/capture-redaction.test.ts) · [`ui-plan`](apps/context-agent/src/lib/ui-plan.test.ts) · [`github-publication`](apps/context-agent/src/lib/github-publication.test.ts) · [`organization-access`](apps/context-agent/src/lib/organization-access.test.ts) |
| **Validation is a hard block, not a warning** | [`ui-plan.ts`](apps/context-agent/src/lib/ui-plan.ts) returns errors for unapproved components, props, variants, tokens, manifest mismatch, and unreadable citations; [`canvas.ts`](apps/context-agent/src/routes/canvas.ts) rejects with `422` before the React emitter runs. Advisory state coverage is a separate function, documented as non-blocking |
| **Approval cannot be swapped out from under you** | [`publication.ts`](apps/context-agent/src/routes/publication.ts) re-validates at approval time and returns `409 Publication changed after review` when the artifact, file set, repository, or approver no longer matches the token |
| **The end-to-end path works** | The `apps/studio` Playwright workflow creates an isolated account and organization, imports and indexes a redacted product capture, verifies encrypted screenshot access and search, exercises comments and history restoration, and checks read-only sharing and revocation |
| **Migrations are not hand-waved** | 16 transactional Drizzle migrations, applied against real PostgreSQL in CI on every push |
| **The resource ceiling is enforced, not claimed** | [`resource-gate.ts`](apps/desktop/scripts/resource-gate.ts) launches the built app, waits for health, samples settled usage, quits, and fails on surviving child processes. Runs at release rather than in CI, because it needs a built macOS bundle: `bun run --cwd apps/desktop test:resource` |

## Current boundaries

> [!NOTE]
> Stated up front, because a boundary you can read is worth more than one you discover.

- **Single-device.** Workspace data lives on one Mac. Cloud sync, networked multiplayer, and live cursors are deferred.
- **Screen awareness is experimental and untested.** See [below](#screen-awareness).
- **Team scoping was removed, not finished.** Teams were half-wired and unreachable from the UI, so they went rather than shipping a half-built permission model. Visibility is personal or organization.
- **The resource ceiling was raised** from 2% / 750 MB to 2.8% / 1050 MB to make room for screen awareness. If that surface does not survive, the ceiling returns.
- Figma is an **input only**; editable Figma export is deferred.
- The canvas organizes evidence and generated artifacts but does **not** provide vector drawing or low-level component editing.
- Remote AI is optional, but **local embedding and generation models are not bundled** in this release.
- Connector synchronization is **manual by default**; webhooks and continuous background sync are deferred.
- The DMG must be **signed and notarized** with Apple Developer credentials before public distribution. Development builds are ad-hoc signed.

## Architecture

A Bun and Turborepo monorepo with five active packages:

| Package | Responsibility |
| --- | --- |
| [`apps/desktop`](apps/desktop) | Tauri macOS shell, managed local runtimes, lifecycle, backup, restore, screen surfaces, and DMG packaging |
| [`apps/context-agent`](apps/context-agent) | Hono API, Better Auth, ingestion, search, connectors, jobs, generation, GitHub publication, and MCP |
| [`apps/studio`](apps/studio) | Next.js canvas workspace for knowledge, product reasoning, review, and prototypes |
| [`apps/capture-extension`](apps/capture-extension) | Chrome Manifest V3 product capture and local redaction preview |
| [`packages/db`](packages/db) | Drizzle schema, PostgreSQL and pgvector access, and transactional migrations |

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

## Screen awareness

> [!WARNING]
> **Experimental — treat it as unfinished.** Shipped on `main` so it can be tested in a real build. It is not covered by the test suites above, and its shape will change.

A notch-anchored HUD window can capture the screen, read the accessibility element under the cursor, fall back to OCR for text the accessibility tree does not expose, and draw a click-through cursor companion. Implemented across [`screen.rs`](apps/desktop/src-tauri/src/screen.rs), [`pointer.rs`](apps/desktop/src-tauri/src/pointer.rs), and a Swift `screen-agent` helper, exposed as four Tauri commands — `screen_permissions`, `screen_capture`, `screen_element`, `screen_copy_mode` — under explicit capability manifests.

Nothing is captured until the HUD is toggled on from the canvas, and macOS independently gates it behind Screen Recording and Accessibility permission.

The intent is to close the gap between a workspace you visit and a layer that sees what you are already working on. The reasoning substrate — project graph, ACL-filtered retrieval, pinned design manifests — already exists; this is the perception half.

## Privacy and consent

Workspace records, object files, search indexes, generated files, revisions, and backups are **local by default**. Context Layer shows the selected provider and data boundary before sending content to a remote service for embeddings, image description, transcription, or generation. Consent is recorded per organization, provider, capability, and policy version, and can be revoked.

The local runtime binds Studio, the API, and PostgreSQL to `127.0.0.1`. External connector principals must map to a local user or organization grant; unmapped access **fails closed**. Project visibility is personal or organization, and project roles are:

| Role | Can |
| --- | --- |
| `owner` | Membership, settings, design pinning, approval, and publication |
| `editor` | Canvas and artifact changes, imports, and generation |
| `viewer` | Reading and comments |

Projects support member roles, organization sharing, node comments, mentions, resolution, and **expiring revocable read-only links**.

The capture extension never collects cookies, local storage, authorization headers, password values, hidden inputs, arbitrary scripts, or inaccessible cross-origin frame contents. Form values are masked by default and the capture is shown locally for redaction before upload.

## Detailed capabilities

<details>
<summary><b>Knowledge, canvas, capture, and connectors</b></summary>

**Inputs.** Plain text, Markdown, HTML, JSON, CSV, PDF, DOCX, PPTX, XLSX, common images, audio, video. Extraction preserves page, slide, sheet, URL, timestamp, frame, connector, and source-revision provenance. HTML scripts and styles are ignored. Media processing is bounded and runs through the bundled macOS helper; remote descriptions or transcripts require provider consent.

**Connectors.** `GitHub` · `Notion` · `Google Drive` · `Slack` · `Confluence` · `Figma files and read-only libraries` · `Allowlisted Streamable HTTP MCP servers` · `Web URLs`. Initial and incremental sync, cursor persistence, deletions, cancellation, retries, rate limits, expired credentials, revoked access. Manual by default in the desktop release. Remote MCP must use HTTP or HTTPS, match `OUTBOUND_MCP_ALLOWLIST`, remain on its original allowlisted origin, and cannot redirect to or resolve as a private-network address.

**Search.** Structure-aware chunks and reciprocal-rank fusion across PostgreSQL full-text and pgvector rankings. Every result is filtered through organization, user, project, and source grants before it reaches a prompt. Answers and generated artifacts require citations whenever accessible grounding exists; selecting one focuses its source node on the canvas.

**Canvas.** Each project starts with a default infinite canvas. Nodes reference durable sources and artifacts while keeping position separate from content. Artifacts include briefs, requirements, user flows, state matrices, UX reviews, interface specifications, test cases, and React prototypes. Edges can be `derived_from`, `supports`, `contradicts`, `flows_to`, `implements`, or `references`. Edits autosave with optimistic object versions; changes to different objects merge independently, and conflicting changes to the same object return a visible conflict. Checkpoints before imports, generation, regeneration, deletion, and restoration.

**Capture.** Build the extension and load `apps/capture-extension/dist` as an unpacked Chrome extension (`bun run --cwd apps/capture-extension build`). Create a short-lived capture token from a project, then enter the local API URL, project ID, and token in the extension options. Each accepted step stores its sanitized outline and screenshot through encrypted local object storage, creates a canvas node, indexes safe visible text, and links the sequence with `flows_to` edges. Processing state and failures appear on the node.

</details>

<details>
<summary><b>Design system, generation, and publication</b></summary>

**Design system.** A version **cannot be activated until it has a valid `DesignManifestV1`**. Imports create drafts and preserve source and validation provenance. Owners resolve validation issues and merge conflicts before activation; every project pins exactly one immutable active version. The manifest can include package imports, browser and CSS entries, foundations, tokens, primitives, components, patterns, templates, props, variants, slots, examples, accessibility guidance, composition constraints, and source mappings. Package inspection blocks install scripts, path traversal, executable macros, unbounded archive expansion, arbitrary network access, and known unbounded execution patterns. Design assets can be searched and placed on the canvas as context.

**Reasoning.** The composer routes prompts to research synthesis, product briefs, requirements, flow mapping, state matrices, edge-case review, interface specifications, tests, or React generation. Before interface generation, the reasoning layer covers permissions, loading, empty, validation, error, retry, quota, and recovery states; missing coverage is surfaced as advice rather than a hard block.

**Generation.** An interface specification contains a structured `UiPlan` with approved asset IDs, imports, props, variants, tokens, navigation, screen states, citations, file structure, target framework, and pinned manifest version. Context Layer **rejects invented assets or unreadable citations** before generating multi-file React and TypeScript for Vite or Next.js. Compilation runs in one short-lived worker. Preview output is served in a sandboxed cross-origin iframe without same-origin access, storage, top-level navigation, or network access by default. Compilation or manifest validation failures block approval and publication.

**Publication.** Uses the locally installed and authenticated `gh` CLI and never reads or stores its credentials. A project owner configures repository, base branch, framework, app root, package manager, allowed paths, and design-system import. Context Layer validates repository access and file boundaries before showing a publication preview. Only an explicit in-product owner approval starts publication, and that approval is re-validated against the artifact, file set, repository, and approver before anything is written. Approved files go to a `contextlayer/<project>-<artifact>` branch and a pull request opens with validation results, citations, artifact references, and design-system provenance. Every attempt has a durable publication audit.

</details>

<details>
<summary><b>MCP server and scopes</b></summary>

The API serves Streamable HTTP MCP at `/mcp` and publishes OAuth 2.1 discovery metadata under `/.well-known/`. Clients can use Better Auth OAuth access tokens or revocable local bearer tokens created through `/api/mcp/tokens`.

Scopes are enforced per tool:

| Scope | Grants |
| --- | --- |
| `knowledge:read` | Search and read accessible knowledge |
| `canvas:read` | Read projects, canvases, and artifacts |
| `design:read` | Read pinned design-system assets |
| `artifacts:write` | Create and revise project artifacts |
| `generation:write` | Validate plans and generate React files |
| `publication:write` | Preview and approve GitHub publication |

Project roles and source ACLs are rechecked on every operation; **a token scope never grants a role the user does not already hold**.

</details>

## Quick start

**Use the app.** The packaging target is **Apple Silicon macOS 13 or newer**. Open the DMG, drag Context Layer to Applications, and launch it. The bundle includes PostgreSQL 17 with pgvector, the API, the production Studio runtime, the prototype compiler, and the media extractor. **Docker, Node.js, Bun, and a separately installed database are not required at runtime.**

Build artifacts are written to:

```text
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/
```

> [!NOTE]
> Unsigned development builds are ad-hoc signed and may require approval in macOS Privacy & Security.

**Run from source.**

```bash
bun install
docker compose up -d db
cp apps/context-agent/.env.example apps/context-agent/.env
cp apps/studio/.env.example apps/studio/.env.local
bun run db:migrate
bun run dev
```

The API defaults to `http://localhost:8787`; Studio defaults to `http://localhost:3000`.

## Development

<details>
<summary><b>Local data, backup, and resource policy</b></summary>

Runtime data lives under `~/Library/Application Support/Context Layer`:

| Directory | Contents |
| --- | --- |
| `database/` | Local PostgreSQL cluster and vector indexes |
| `objects/` | Content-addressed originals and derived media |
| `backups/` | Automatic database backups created before startup migrations |
| `logs/` | PostgreSQL, API, and Studio logs |
| `run/` | Local database socket files |

Connector credentials and application secrets are stored in **macOS Keychain**, not in the data directory. Removing the application does not delete workspace data.

**Restore.** The desktop runtime creates a timestamped PostgreSQL dump before applying migrations to an existing database. To restore one: quit Context Layer, write the absolute path of a `.dump` file from the `backups` directory to `~/Library/Application Support/Context Layer/restore-request`, relaunch. The runtime accepts restore files **only from its own backup directory**, restores before migrations, and removes the request marker after success. Keep a separate copy of the entire data directory for device-level backup.

**Resource policy.** Local-only ports and sockets, capped PostgreSQL memory, one durable ingestion job at a time, automatic connector polling off by default, model concurrency of one, compilation workers started only on demand. Quitting terminates the API, Studio, PostgreSQL, compiler, media helpers, and their process groups. Release gate on an 8 GB Apple Silicon Mac: settled idle CPU under **2.8%**, total idle memory under **1050 MB**, **no** surviving child processes after quit.

</details>

<details>
<summary><b>Requirements, commands, and environment</b></summary>

Requirements: macOS for the desktop and DMG target, Bun `1.3.6`, Node.js 20 or newer for development tooling, PostgreSQL with pgvector (or Docker for the development database only), Rust and Xcode command-line tools for the Tauri bundle.

| Command | Does |
| --- | --- |
| `bun run dev` | Start development applications |
| `bun run build` | Build all packages, including the DMG on macOS |
| `bun run test` | Run package unit tests |
| `bun run check-types` | Type-check the monorepo |
| `bun run format-lint` | Format and lint with Biome |
| `bun run db:generate` | Generate a Drizzle migration |
| `bun run db:migrate` | Apply migrations |
| `bun run --cwd apps/studio test:e2e` | Run the browser workflow |
| `bun run --cwd apps/desktop test:resource` | Run the release resource gate |

[`apps/context-agent/.env.example`](apps/context-agent/.env.example) documents database, Better Auth, encryption, model, connector, and OAuth values. Development requires at minimum `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `STUDIO_URL`, and `CONNECTION_ENCRYPTION_KEY`. Configure only the remote providers you intend to use — provider consent is still required in the product before content is sent.

Model credentials resolve **environment first, then a key entered in the app** and held in macOS Keychain, so an existing `.env` or CI setup is unaffected. Every remote provider is billed as API usage; **consumer subscriptions are not a supported source**. Pointing `LOCAL_CHAT_BASE_URL` at a local model costs nothing and keeps every request on the Mac.

> [!IMPORTANT]
> The production desktop creates its own secrets in macOS Keychain and supplies bundled runtime paths automatically. Do not place credentials in committed files.

</details>

<details>
<summary><b>API surface</b></summary>

| Endpoint | Purpose |
| --- | --- |
| `/health`, `/health/desktop` | Process and desktop runtime health |
| `/api/auth/*` | Better Auth and OAuth provider endpoints |
| `/api/memories`, `/api/memories/search` | Ingestion and ACL-filtered retrieval |
| `/api/ask` | Cited knowledge answers |
| `/api/connections/*` | Connector setup, status, synchronization, and cursors |
| `/api/jobs/*` | Durable job status, progress, retry, and cancellation |
| `/api/privacy/*` | Provider policy and consent |
| `/api/model-auth/*` | Model provider keys, validated and stored in Keychain |
| `/api/projects/*`, `/api/canvases/*` | Memberships, sharing, nodes, edges, comments, artifacts, and history |
| `/api/design-systems/*` | Manifests, imports, validation, activation, and project pinning |
| `/api/capture/*` | Capture token and redacted flow ingestion |
| `/api/publication/*` | Validation preview, explicit approval, and publication audits |
| `/mcp` | Authenticated Streamable HTTP MCP endpoint |

Organization, user, and role identity come from authenticated server context. **Core APIs do not trust client-supplied identity.**

</details>

## License

Context Layer is licensed under the MIT License. See [LICENSE](LICENSE).
