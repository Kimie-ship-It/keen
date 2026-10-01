<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project Guide

## Positioning

This is a local prototype that aggregates public university recruitment notices. It currently supports Beijing University of Aeronautics and Astronautics, Beijing Institute of Technology, Beijing Jiaotong University, and Nankai University; do not describe it as a live nationwide service.

## Run And Verify

- Install/setup: `npm install`, then `npm run setup:local`.
- Develop: `npm run dev` and open `http://localhost:3000`.
- Collect one source with `npm run collect:buaa`, `npm run collect:bit`, `npm run collect:bjtu`, or `npm run collect:nankai`; run all configured sources with `npm run collect:daily`; install the Windows daily task with `npm run schedule:install`.
- Required checks after code changes: `npm test`, `npm run lint`, and `npm run build`.
- After PostgreSQL/runtime changes also run `npm run test:supabase` against temporary rollback-only tables; verify live HTTP with `npm run test:runtime-http` against a separately started website. Never expose credentials in output.

## Stack

Next.js 16 App Router, React 19, TypeScript/JavaScript, local collector SQLite through `better-sqlite3`, website Supabase PostgreSQL through `pg`, and Node test runner.

## Layout And Conventions

- `src/app/` owns pages and HTTP routes; `scripts/` owns collection, storage, notifications, and reusable services.
- `data/`, `.env.local`, logs, database files, snapshots, and `SUPABASE_DB_URL` are local runtime state and must not be committed or exposed.
- Preserve existing rows on collection failure or an unexpected empty source response.
- Public notices remain `pending` until reviewed; UI text must distinguish pending from approved.
- Official links must stay on the configured university host. The app links to notices; it does not submit applications.
- Website storage is explicitly selected with `CAMPUS_JOBS_STORAGE=sqlite|supabase`; never silently fall back on connection failure. Website query/review services are asynchronous in both modes.
- Supabase owns review status, review audit, and admin limits. Collector sync only owns five collection tables and must preserve cloud reviews. Local backups do not yet contain cloud review changes; reconcile these before SQLite rollback.
- TLS certificate verification is on by default. Supabase hosts use the bundled official public CA unless an explicit CA override is configured; this machine no longer uses the insecure exception. Vercel rejects SQLite and insecure TLS. Hosting builds validate server-only configuration before compiling; never bypass this guard to make unconfigured previews succeed.
- Keep `CLAUDE.md` as the pointer to this file and retain the generated Next.js block above.

## Current Status And Next Step

Local database/API/UI, four collectors, reviews, local backups, the Windows daily task, server-side filters, detail pages, and saved-job CSV export are implemented. Industry labels are inferred. Feishu delivery remains deferred and the fifth pilot university is canceled. The Git remote is `https://github.com/Kimie-ship-It/keen.git`; verify push status live before claiming remote delivery. Supabase schema and data are verified and this machine now selects Supabase for website queries, exports, and review writes. The collector stays on SQLite, synchronizing five collection tables after local backup; it never overwrites cloud review status, audit, or auth limits. Vercel is the selected initial hosting candidate, with configuration in vercel.json and docs/HOSTING-DEPLOYMENT.md; account verification is pending and no public deployment exists. Strict database TLS now works locally using the official CA. Hosting/HTTPS, cloud collection, monitoring, cloud backup/recovery, privacy/takedown, and public end-to-end verification remain pending. Review docs/PROJECT-CHECKLIST.md at task start and after each completion; create a step checkpoint backup after verification.
