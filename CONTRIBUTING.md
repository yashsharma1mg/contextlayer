# Contributing to Context Layer

Thank you for helping improve Context Layer. Contributions should strengthen its local-first, canvas-based workflow for product knowledge, product reasoning, design-system intelligence, and validated interface generation.

## Before you start

- Search the [existing issues](https://github.com/yashsharma1mg/contextlayer/issues) before opening a new one.
- For a substantial feature or architectural change, open an issue describing the user problem and proposed behavior first.
- Never commit credentials, provider keys, connector tokens, captured private data, local databases, or generated application data.

## Development setup

The repository is a Bun and Turborepo monorepo. Development requires Bun `1.3.6`, Node.js 20 or newer, PostgreSQL with pgvector, and Docker for the default local database setup. Building the desktop application also requires macOS, Rust, and the Xcode command-line tools.

```bash
git clone https://github.com/yashsharma1mg/contextlayer.git
cd contextlayer
bun install
docker compose up -d db
cp apps/context-agent/.env.example apps/context-agent/.env
cp apps/studio/.env.example apps/studio/.env.local
bun run db:migrate
bun run dev
```

The API defaults to `http://localhost:8787` and Studio defaults to `http://localhost:3000`.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Tauri shell, local runtime lifecycle, and DMG packaging |
| `apps/context-agent` | API, authentication, ingestion, search, jobs, generation, publication, and MCP |
| `apps/studio` | Canvas workspace and product interface |
| `apps/capture-extension` | Chrome product capture and local redaction preview |
| `packages/db` | Drizzle schema, PostgreSQL access, and migrations |

## Making changes

1. Create a focused branch from `main`.
2. Follow the existing TypeScript, React, API, and database patterns.
3. Keep organization, project, and source authorization checks on the server.
4. Preserve local-first behavior and require informed consent before sending user context to a remote provider.
5. Add the smallest test that protects changed behavior.
6. Update documentation when setup, privacy boundaries, or user-visible behavior changes.

For schema changes, generate and review a Drizzle migration. Do not edit an existing applied migration.

## Required checks

Run the checks relevant to your change before opening a pull request:

```bash
bun run format-lint
bun run check-types
bun run test
bun run build
bun run --cwd apps/studio test:e2e
```

Desktop changes should also be exercised through application startup, clean shutdown, and DMG installation. Connector changes should cover initial synchronization, incremental updates, deletions, revoked access, expired credentials, and retry behavior.

## Pull requests

Keep pull requests focused and explain:

- the user problem and resulting behavior;
- the implementation and important tradeoffs;
- privacy, authorization, migration, or resource-use implications;
- checks performed and any remaining test gaps;
- screenshots or recordings for visible interface changes.

Do not include unrelated formatting, generated output, local caches, application data, or secrets. Review feedback should be resolved with follow-up commits rather than rewritten public history.

## Reporting security issues

Do not disclose suspected vulnerabilities or leaked credentials in a public issue. Use GitHub's private vulnerability reporting for this repository. Include reproduction steps, affected versions, impact, and any suggested mitigation.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
