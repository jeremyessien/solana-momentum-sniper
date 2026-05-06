# ADR 004: Toolchain and Core Library Selection

## Status

Accepted, 6 May 2026. This decision was made before any code was written, locking in the concrete tooling and library choices that the engineering standards and practical guide describe in general terms but do not name specifically. After any code begins depending on this ADR, future changes will be handled by superseding ADRs rather than by editing this document.

## Context

The engineering standards document specifies many qualities the toolchain should have. Code must be modern idiomatic TypeScript with strict mode and ES modules. Errors must flow as Result values rather than exceptions. Logs must be structured with severity levels. External inputs must be validated at adapter boundaries. Tests must run fast enough to be run frequently. The linter must enforce style choices automatically. The build must produce sourcemaps. The standards name some specific tools as examples — Vitest for testing, Biome or ESLint for linting, Zod for schema validation — but stop short of committing to any of them. The practical guide commits to pnpm as the package manager and recommends a Node version manager, but otherwise leaves the concrete choices open.

This ADR locks in those concrete choices. It is not introducing new policy. It is selecting specific tools that satisfy the policy already established by the standards and the practical guide. Recording the choices in an ADR rather than just adding them to a configuration file serves the same purpose as every other ADR in this project: it captures the reasoning so that a future session does not relitigate decisions that have already been made and does not have to reverse-engineer the rationale from configuration files alone.

The choices below were made on the basis of current ecosystem state as of May 2026, verified through web research where the answer was not obvious from the docs we already have. Where a tool was named in the standards or practical guide, that mention is treated as authoritative and this ADR confirms the choice rather than reopening it.

## Decision

The runtime is **Node.js on the current LTS line (Node 22 or later)**, installed and managed through **fnm**. The current LTS line is required by Vitest 3 and Jest 30, supports native ES modules without ceremony, and supports the native `--env-file` flag that removes the need for a separate dotenv dependency. fnm is preferred over nvm because it is significantly faster, ships as a single Rust binary, and integrates more cleanly with shell startup.

The package manager is **pnpm**. The practical guide already commits to this choice. pnpm uses a content-addressed store and symlinks rather than copying packages, which produces faster installs, less disk usage, and stricter dependency resolution that catches phantom dependencies — packages used in code without being declared in `package.json`. The lockfile is committed to version control so that the dependency graph is reproducible.

The language is **TypeScript in strict mode** with all strict flags enabled, targeting **ES2022** and emitting **ES modules only**. CommonJS is not supported. The standards document names this configuration explicitly; this ADR confirms it.

For development, source files are run directly through **tsx**, which uses esbuild internally for near-instant transpilation. For production builds, the TypeScript compiler `tsc` is used to produce `.js` and `.d.ts` outputs alongside sourcemaps. There is no separate bundler. The bot runs as a Node process consuming the compiled JavaScript files and a small set of installed dependencies; bundling would add complexity without benefit.

The test runner is **Vitest**. It is the modern default for TypeScript ESM projects, handles ES modules natively without the `--experimental-vm-modules` flag that Jest still requires, and integrates cleanly with the Vite-based ecosystem. Its API surface mirrors Jest, so most testing patterns translate directly. The standards document already named Vitest as the example; this ADR confirms it.

The linter and formatter are both **Biome**. Biome covers approximately eighty percent of the rules common in ESLint configurations, provides formatting equivalent to Prettier, and runs ten to twenty-five times faster than the ESLint-plus-Prettier pair because it is implemented in Rust with a single shared parser and AST. The single-tool, single-config-file setup eliminates a class of integration issues. The rules Biome does not yet cover are framework-specific or type-aware lint rules; we use no UI framework that depends on the framework plugins, and our type-aware checks come from `tsc` itself.

The schema validation library is **Zod**. The standards document names it explicitly. It is used at every adapter boundary where untrusted external data enters the system, including the configuration loader, the Helius response parser, the Jupiter response parser, and the Telegram command handler.

The logger is **pino**. Pino emits structured JSON logs by default with severity levels matching what the standards document requires. It is the fastest logger in the Node ecosystem by a wide margin and has first-class support for log rotation through external tools and its own transport mechanism. The standards do not name pino specifically, but its design fits Principle Six exactly.

The Solana SDK is **`@solana/kit`** (the rebranded successor to `@solana/web3.js` v2). It replaces the legacy `@solana/web3.js` v1 with a modular, tree-shakeable, fully type-safe API that exposes Solana primitives through individual packages composed under one umbrella. It supports modern features like native `BigInt` arithmetic and produces measurably faster confirmation latency than v1. The legacy library remains the right choice only for projects that depend on Anchor, which we do not.

For Solana RPC and gRPC access, the **Helius SDK** is used alongside `@solana/kit`. The Helius SDK exposes Helius-specific endpoints, including their enhanced transaction APIs and their priority fee estimation. The general-purpose Solana RPC operations go through `@solana/kit`'s RPC client pointed at the Helius endpoint URL. The specific gRPC streaming client for token detection is named in a future ADR when the detection layer is implemented, since the choice depends on details of the streaming surface that are easier to evaluate when the adapter is being written.

The Telegram bot framework is **grammY**. It has native TypeScript support that works without complex generic gymnastics, comprehensive documentation maintained as a usage guide rather than only as a generated API reference, and weekly download counts more than double those of the older Telegraf library. It is actively maintained and the type inference is strong throughout the API. Telegraf has a larger historical install base but its types are reportedly difficult to use and its documentation is no longer maintained as a guide.

The database is **SQLite accessed through `better-sqlite3`**. SQLite fits a single-process single-machine bot exactly: the entire database is one file, transactions are atomic, the engine is embedded in the process so there is no network overhead, and the file is trivial to back up. The `better-sqlite3` driver provides a synchronous API that is faster than the asynchronous `sqlite3` driver for embedded use, because there is no real I/O parallelism to be gained from making single-file local access asynchronous. Postgres or another networked database would be over-engineering at our scale and would add a deployment dependency on Hetzner that we do not need.

Configuration is loaded from a `.env` file using **Node's native `--env-file` flag**, with values then validated and parsed through Zod into a typed configuration object that is the only thing the rest of the system uses. There is no third-party `dotenv` library; the runtime ships with this functionality.

For the eventual Hetzner deployment, the bot runs as a **systemd unit** under a dedicated unprivileged user account, with output captured through journald. The unit file restarts the bot on failure with a backoff and enforces resource limits including the disabled core dumps required by ADR-001. The full operational security setup is the subject of a deferred ADR; this ADR commits only to the choice of systemd as the supervisor.

## Consequences

The strict commitment to ES modules means that any dependency that does not ship ES modules will be friction. Most modern libraries ship dual builds; the few that remain CommonJS-only are usually replaceable with modern equivalents. When we hit a CommonJS-only dependency that has no alternative, the path is to wrap it behind an adapter, not to relax the ESM commitment.

The Biome rule-coverage gap means there are some niche style rules ESLint would catch that Biome does not. We accept this because the rules in question are mostly framework-specific or stylistic preferences that the Biome maintainers have decided not to encode. If we ever discover a class of bug that Biome cannot catch but ESLint can, we revisit, possibly running both. Until then, the speed and configuration simplicity of Biome dominate.

The choice of `@solana/kit` over the legacy `@solana/web3.js` means that some older example code, tutorials, and StackOverflow answers will reference v1 patterns that do not translate directly. This is the expected friction of choosing the newer library, and the migration guide on the Solana docs site covers the differences. The benefits in type safety, performance, and modularity outweigh the friction.

The choice of SQLite means we are bound to a single-machine deployment for the database. This matches the architectural decision in `architecture.md` that the system is not distributed. If the system ever grows beyond one machine — which the architecture document explicitly says we will not preemptively design for — the database becomes one of the things that needs to migrate. We accept this constraint because it is consistent with the existing architectural framing.

The choice of synchronous database access through `better-sqlite3` means that database operations briefly block the Node event loop. For our workload — modest write rates from event subscribers, occasional analytical reads — this is fine and in fact faster than the asynchronous alternative. If we ever encounter a workload where this becomes a bottleneck, the worker-thread escape hatch is available.

The choice of pnpm and its strict-resolution model means that some packages with broken peer-dependency declarations may produce warnings on install. These warnings are signals about ecosystem hygiene rather than about our project; they are addressed by patching package metadata or by accepting them where the package functions correctly despite the metadata.

## Alternatives Considered

We considered **Jest** as the test runner. Jest 30, released in mid-2025, made significant improvements to ESM support, performance, and configuration leanness. Despite this, its ESM mode still requires the `--experimental-vm-modules` flag, marking ESM as not-fully-supported. For a project committed to ESM from the outset, Vitest's native ESM support is the safer foundation.

We considered **ESLint plus Prettier** as the linter-and-formatter pair. The ESLint ecosystem is larger and there are some specialised rules — particularly type-aware rules and framework-specific plugins — that Biome does not cover. We rejected this combination because the rules we would lose are not relevant to a server-side TypeScript project without a frontend framework, and the speed advantage of Biome is meaningful in a CI context.

We considered the legacy **`@solana/web3.js` v1** as the Solana SDK. It has the largest install base, the most tutorial coverage, and the most StackOverflow answers. We rejected it because v1 is the legacy library and v2 (now `@solana/kit`) is the recommended path for new projects per the official Solana documentation, with measurably better performance and modern TypeScript support.

We considered **Telegraf** as the Telegram framework. It has a longer history and a larger total install count. We rejected it because its TypeScript story is reportedly painful and its documentation is no longer maintained as a usage guide. grammY is the modern alternative and the better fit for a TypeScript-first codebase.

We considered **winston** as the logger. Winston has a longer history and more transports out of the box. We rejected it because pino is faster, simpler, and emits structured JSON by default, which fits Principle Six more directly.

We considered **PostgreSQL** as the database. Postgres provides richer query capabilities, robust concurrency, and a path to scaling. We rejected it because all of those benefits address problems we do not have on a single-machine personal trading bot, and adding Postgres as a deployment dependency increases the surface area we have to operate on Hetzner. SQLite is the right tool for our scale.

We considered adding **DuckDB** alongside SQLite for the analytical observation data Phase 1 produces. DuckDB is a column-store engine optimised for analytical queries. We rejected adding it as a second engine because SQLite handles analytical workloads adequately at our scale, and managing two databases would be over-engineering. If the observation dataset grows large enough that analytical queries become slow on SQLite, DuckDB is the right tool to revisit at that point.

We considered **dotenv** or **dotenv-flow** for configuration loading. We rejected them because the current Node LTS supports `--env-file` natively, removing the need for an additional dependency.

We considered **PM2** as the process manager for the eventual Hetzner deployment. PM2 is widely used in Node deployments and offers features like log management and clustering. We rejected it because systemd is native to the Linux server, has stronger integration with the operating system's resource limits and logging, and avoids adding a Node-specific runtime dependency to the deployment. The clustering features PM2 offers are not relevant to a single-process bot.

## Implementation Notes

The `package.json` declares `"type": "module"` to make ESM the default. The `engines` field pins the current LTS line as the minimum supported runtime. The `scripts` section provides the standard verbs: `dev` for running through tsx, `build` for compiling with tsc, `test` for Vitest, `typecheck` for tsc with `--noEmit`, `lint` for Biome's lint command, and `format` for Biome's format command.

The `tsconfig.json` enables strict mode with all strict flags, sets `module` and `moduleResolution` to NodeNext, sets `target` to ES2022, enables `verbatimModuleSyntax` to enforce explicit type-only imports, and points the build output at a `dist/` directory excluded from version control.

The `biome.json` enables the recommended rule set with adjustments documented inline where they deviate from the defaults. The formatter settings match the conventions the engineering standards establish: two-space indentation, single quotes for strings, trailing commas on multi-line literals, semicolons required.

The `vitest.config.ts` configures the test environment to match Node, sets the test file pattern to match files with the `.test.ts` extension, and enables coverage reporting using V8's native instrumentation rather than istanbul, since V8 coverage is faster and accurate enough for our purposes.

A `.env.example` file documents the required environment variables without including any secret values. The real `.env` file is excluded from version control through `.gitignore`. The configuration loader at `src/infrastructure/config/configLoader.ts` reads `process.env`, validates it with Zod, and exposes a typed `Config` object that the rest of the system imports.

The folder structure inside `src/` follows the seven-module organisation from the architecture document, with each module getting a dedicated subdirectory. Shared types and utilities live under `src/shared/`. Tests live alongside the code they test using the `.test.ts` suffix.

When working with Claude Code on this configuration, deviations from these tooling choices should be challenged and either justified through a superseding ADR or rejected. The toolchain is the foundation everything else builds on, and changes to it ripple through every file. Stability here matters more than minor optimisations.