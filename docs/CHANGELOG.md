# Changelog

## 0.1.0

- Added Tauri + React + TypeScript scaffold.
- Added Mantine UI shell with Dashboard, Models, Server, Logs, Admin, Profile, and Settings pages.
- Added SQLite persistence and first-run migrations.
- Added user, role, API key, model, settings, and request log data flows.
- Added OpenAI-compatible `GET /v1/models` and non-streaming `POST /v1/chat/completions` endpoints.
- Added process-based `llama.cpp` adapter configuration.
- Added commercial-use dependency license gates for Node and Rust.

## Unreleased

- Added first-run admin setup; no default admin is seeded.
- Added desktop login screen before the application dashboard.
- Added dark visual styling for desktop and web.
- Added browser-viewable dashboard served by the local API server at `/`.
- Added web setup and login endpoints plus authenticated web data endpoints: `/web/setup-state`, `/web/setup`, `/web/login`, `/web/dashboard`, and `/web/logs`.
- Added admin-only model Load/Eject controls on the Models page.
- Added a multi-model runtime that starts one private `llama-server` process per loaded GGUF model and keeps each model resident in RAM until ejected.
- Routed chat completions through the public LLMeter port by model name, then internally proxies to the matching private `llama-server` process.
