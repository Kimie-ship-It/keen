<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project Guide

## Positioning

This is a local prototype that aggregates public university recruitment notices. It currently supports Beijing University of Aeronautics and Astronautics and Beijing Institute of Technology; do not describe it as a live nationwide service.

## Run And Verify

- Install/setup: `npm install`, then `npm run setup:local`.
- Develop: `npm run dev` and open `http://localhost:3000`.
- Collect one source with `npm run collect:buaa` or `npm run collect:bit`; run all configured sources with `npm run collect:daily`; install the Windows daily task with `npm run schedule:install`.
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

Local database/API/UI, BUAA and BIT collectors, review controls, multi-source backups, and a Windows daily task are implemented. Feishu delivery is optional and is not considered live until a real webhook is configured and verified. Next, onboard the third pilot university and continue expanding gradually before any production deployment.
