# Testnotary

Local test attestations that let CI skip a test job it can trust.

## Development

Needs Node 24 or later, pnpm 10 and Docker.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test          # the world tests (Vitest), then the browser tests (Playwright)
```

The first browser run needs `pnpm exec playwright install --only-shell chromium`.

| Path | What it is |
| --- | --- |
| `packages/testnotary` | the library and CLI, published to npm as `testnotary` |
| `packages/action` | the GitHub Action; `action.yml` at the root runs its release bundle |
| `packages/core` | the domain rules, shared by the library, the action and the service |
| `packages/protocol` | wire types and zod schemas for `/api/v1` |
| `apps/web` | the service and web app (Next.js), with Drizzle migrations in `apps/web/drizzle` |
| `packages/test-world` | the shared test world every test runs in |

Local Postgres for the web app: `pnpm db:up`, then
`MIGRATION_DATABASE_URL=postgres://testnotary_migration:testnotary_migration@127.0.0.1:54329/testnotary pnpm db:migrate`
and run the app with `DATABASE_URL=postgres://testnotary_app:testnotary_app@127.0.0.1:54329/testnotary`.

The JSON schema for `testnotary.json` is generated from the parser in `packages/core/src/config.ts`
into `apps/web/public/schema/v1.json`, which the web app serves at
`https://testnotary.dev/schema/v1.json`. Run `pnpm schema:write` after changing the config rules.
