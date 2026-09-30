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

## Stack

Next.js 16 App Router, React 19, TypeScript/JavaScript, SQLite through `better-sqlite3`, and Node test runner.

## Layout And Conventions

- `src/app/` owns pages and HTTP routes; `scripts/` owns collection, storage, notifications, and reusable services.
- `data/`, `.env.local`, logs, database files, and snapshots are local runtime state and must not be committed or exposed.
- Preserve existing rows on collection failure or an unexpected empty source response.
- Public notices remain `pending` until reviewed; UI text must distinguish pending from approved.
- Official links must stay on the configured university host. The app links to notices; it does not submit applications.
- Keep `CLAUDE.md` as the pointer to this file and retain the generated Next.js block above.

## Current Status And Next Step

Local database/API/UI, BUAA, BIT, BJTU, and Nankai collectors, review controls, multi-source backups, a Windows daily task, server-side university, city, industry, and deadline filtering, independent recruitment detail pages, and browser-local saved-job CSV export are implemented. Industry labels are rule-based and include an explicit “未分类” bucket. Feishu setup and test commands exist, but delivery is not live until a real group webhook is configured and received. The fifth pilot university is canceled for this phase. The repository is connected to `https://github.com/Kimie-ship-It/keen.git`, with local `master` tracking the remote commit. Supabase PostgreSQL is selected, the test project exists, and the initial schema migration with RLS has been applied. The local backup is now imported and the seven table counts match the local CSV backup (`jobs 4882`, `job_locations 13761`, `job_industries 9714`, `source_runs 26`, `source_status 4`, `review_events 0`, `admin_auth_limits 1`). Next, configure the hosted scheduler before enabling cloud collection.
