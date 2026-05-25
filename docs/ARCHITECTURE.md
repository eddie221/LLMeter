# LLMeter Architecture

## Runtime Shape

LLMeter is a Tauri desktop app with a React + TypeScript frontend and a Rust backend. The frontend starts with first-run setup or login, then renders the control dashboard. The Rust backend owns persistence, API key auth, local HTTP server lifecycle, and the process-based `llama-server` residency adapter.

## Frontend

- `src/main.tsx` contains the Mantine app shell and pages: Dashboard, Models, Server, Logs, Admin, Profile, and Settings.
- Frontend-to-backend calls use Tauri `invoke` commands from `@tauri-apps/api/core`.
- Charts are simple CSS bars to avoid adding a charting dependency before license review.

## Backend

- `src-tauri/src/lib.rs` wires Tauri state and commands.
- `src-tauri/src/db.rs` manages SQLite migrations and CRUD operations.
- `src-tauri/src/server.rs` runs the OpenAI-compatible HTTP server with API-key authentication.
- `src-tauri/src/model_runtime.rs` keeps one selected model resident through `llama-server`; `src-tauri/src/inference.rs` proxies chat requests to that loaded model.
- `src-tauri/src/auth.rs` centralizes key generation, hashing, timestamps, and approximate token counting.

## Persistence

SQLite is stored under the Tauri app data directory as `llmeter.sqlite`. First launch creates tables for users, API keys, models, request logs, and settings. No default admin is seeded; the first admin is created through setup.

## API Surface

- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /` web dashboard
- `GET /web/setup-state`
- `POST /web/setup`
- `POST /web/login`
- `GET /web/dashboard`
- `GET /web/logs`

Both endpoints require `Authorization: Bearer <api_key>`.

## Commercialization Guardrails

- Node production dependencies are checked with `npm run license:node`.
- Rust dependencies are checked with `cargo deny --manifest-path src-tauri/Cargo.toml check licenses`.
- User-imported model weights are not redistributed by the app; bundled model weights must be reviewed separately.
