# Commercializable Local LLM Desktop Server TODO

## License Policy

Allowed dependency licenses: MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, MPL-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, ISC, Zlib, Unicode-3.0, and SQLite public domain.

Disallowed by default: GPL, AGPL, LGPL, SSPL, Commons Clause, CC-BY-NC/non-commercial licenses, Business Source License, and source-available-only licenses.

Model weights are separate from application code. User-imported models are allowed, but bundled demo models must be reviewed for commercial redistribution before shipping.

## Milestone 1: Scaffold and License Gate

- [x] Create Tauri + React + TypeScript scaffold.
- [x] Use Mantine for UI.
- [x] Use Vite for frontend tooling.
- [x] Add Rust backend module structure.
- [x] Add Node license audit script.
- [x] Add Rust `cargo-deny` license policy config.
- [x] Run full dependency installation and license audits in local environment.

Verify:
- [x] App source tree exists.
- [x] Frontend routes/pages are implemented.
- [x] Tauri commands are wired.
- [x] `npm run build` passes.
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` passes.
- [x] `npm run license:check` passes.

## Milestone 2: SQLite Data Model and Auth Foundation

- [x] Add SQLite persistence with first-run migrations.
- [x] Add `users`, `api_keys`, `request_logs`, `models`, and `settings` tables.
- [x] Show first-run setup and create the first admin through setup instead of seeding a default admin.
- [x] Store API keys as hashes and only reveal raw keys at creation.
- [x] Support `admin` and `user` roles.
- [x] Add user and API key backend operations.
- [ ] Replace v1 SHA-256 password hashing with a reviewed commercializable password KDF before production release.

Verify:
- [x] Database initializes on first launch.
<!-- - [ ] Default admin exists. -->
- [x] API key create/delete works.
- [x] Invalid, deleted, or disabled-user keys fail authentication.

## Milestone 3: Model Management

- [x] Import models by local file path.
- [x] Store model name, path, size, format, and status.
- [x] Mark GGUF files as ready and non-GGUF files as unsupported.
- [x] Add Models UI page with empty state and import flow.
- [x] Avoid Hugging Face downloads in v1.

Verify:
- [x] Imported models persist after restart.
- [x] Missing/invalid paths show clear UI errors.
<!-- - [ ] Zero-model state is usable. -->

## Milestone 4: Local API Server Lifecycle

- [x] Implement Rust-managed HTTP server.
- [x] Default bind is `127.0.0.1:1234`.
- [x] Add start/stop/status commands and UI controls.
- [x] Implement authenticated `GET /v1/models`.
- [x] Require `Authorization: Bearer <api_key>` for API endpoints.
- [x] Show stopped/starting/running/error states.

Verify:
- [x] Server starts and stops from UI.
- [x] Authenticated `GET /v1/models` works.
- [x] Unauthenticated requests return `401`.
<!-- - [ ] Port conflicts show actionable errors. -->

## Milestone 5: llama.cpp Inference Adapter

- [x] Add process-based `llama.cpp` executable integration.
- [x] Add setting for `llama.cpp` executable path.
- [x] Implement non-streaming `POST /v1/chat/completions`.
- [x] Support `model`, `messages`, `temperature`, and `max_tokens`.
- [x] Return OpenAI-compatible response shape.
- [x] Do not bundle model weights.
- [x] Load the model with given path.
    - Only Admin can execute this command.
    - User will only be presented the loaded model.

Verify:
- [x] Valid chat request path is wired through the configured loaded GGUF model and llama-server executable.
- [x] Unknown model returns a structured error.
- [x] Invalid request body returns `400`.
- [x] Missing executable shows a clear setup error.

## Milestone 6: Request Logging and Token Usage

- [x] Log authenticated chat requests to SQLite.
- [x] Store endpoint, model, API key prefix, input, output, token counts, status, error, and timestamp.
- [x] Use a clearly approximate token estimate fallback.

Verify:
- [x] Successful requests appear in logs.
- [x] Failed authenticated requests appear in logs.
- [x] Token totals persist after restart.

## Milestone 7: Dashboard and Logs UI

- [x] Add Dashboard overview.
- [x] Add dependency-free model usage bar chart.
- [x] Add Logs page with search and detail modal.
- [x] Apply role filtering in log/dashboard backend queries.

Verify:
- [x] Search works.
- [x] Admin sees all logs.
- [x] User sees only own logs.
- [x] Dashboard totals match SQLite data.

## Milestone 8: Admin and Profile Pages

- [x] Add Admin page visible only to admin users.
- [x] Add user create/enable/disable/delete operations.
- [x] Add API key management.
- [x] Add Profile page with personal API key management.
- [x] Add UI flow for changing the current user's password.
- [x] Add UI flow for editing current user's display name.

Verify:
- [x] Admin page is hidden from normal users.
- [ ] Account disable/delete affects API access.
- [x] Users cannot edit other users through Profile.

## Milestone 9: Settings and Network Configuration

- [x] Add Settings page for host, port, default model, llama-server executable path, and non-localhost confirmation.
- [x] Persist settings in SQLite.
- [x] Reject non-localhost binds unless explicitly allowed.

Verify:
- [x] Settings persist after restart.
- [ ] Updated port is used after restart.
- [ ] Invalid port is rejected.
- [ ] Non-localhost bind requires explicit confirmation.

## Milestone 10: Final Acceptance Pass

- [ ] App launches successfully.
- [x] Models are listed.
- [x] Server starts correctly.
- [ ] Authenticated `GET /v1/models` works.
- [ ] Authenticated `POST /v1/chat/completions` works.
- [x] Logs are visible in UI.
- [ ] Admin/user role boundaries work.
- [ ] App remains usable with no models, invalid API key, stopped server, and failed inference process.
- [ ] Full dependency license report contains only allowed licenses or explicitly documented exceptions.

## Web Dashboard

- [x] Serve a browser-viewable dark dashboard from the local API server at `/`.
- [x] Start the web dashboard at first setup or login and require authenticated dashboard data endpoints.
- [x] Add web endpoints for dashboard summary and recent logs.
- [ ] Add HTTPS/reverse-proxy documentation before recommending public internet exposure.

## Model Residency

- [x] Add admin-only Load and Eject controls to the Models page.
- [x] Keep one selected GGUF model resident through a long-running `llama-server` process.
- [x] Route chat completions through the loaded model runtime.
- [x] Eject kills the loaded model process and frees RAM.
- [x] Add multi-model residency by running one private `llama-server` process per loaded model and routing requests by model name through the public LLMeter port.
- [ ] Add memory controls and queueing limits for large multi-model deployments.
