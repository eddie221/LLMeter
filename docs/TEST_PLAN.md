# LLMeter Test Plan

## Automated Checks

- `npm run build`: TypeScript and Vite production build.
- `cargo check --manifest-path src-tauri/Cargo.toml`: Rust backend compile check.
- `npm run license:check`: Node production dependency audit plus Rust cargo-deny license audit.

## Manual Acceptance

1. Launch the desktop app with `npm run tauri -- dev`.
2. On a fresh database, confirm First Setup appears and creates the first admin account.
3. Confirm the desktop app starts at Sign In after setup.
4. Log in and confirm the Dashboard, Models, Server, Logs, Admin, Profile, and Settings pages render.
5. Create an API key from Admin or Profile and copy the raw key shown once.
6. Import a local `.gguf` model path from Models.
7. Set a `llama.cpp` executable path in Settings.
8. Start the server from Server.
9. Verify models:
   `curl -H "Authorization: Bearer <api_key>" http://127.0.0.1:1234/v1/models`
10. Verify chat completions with a configured loaded GGUF model and llama-server executable.
13. Confirm successful and failed authenticated chat requests appear in Logs.
14. Confirm Dashboard totals update from logged requests.
11. Confirm Admin is hidden for non-admin users after role changes.
12. Confirm invalid API keys return `401`.

## Current Known Gaps

- Password storage uses salted SHA-256 for v1 scaffolding; replace with a reviewed password KDF before production release.
- Native file picker is intentionally deferred to avoid adding another plugin dependency before license review.
- Streaming chat completions are not implemented yet.

## Web Dashboard Acceptance

1. Start the LLMeter API server.
2. Open `http://127.0.0.1:1234/` in a browser.
3. Confirm the web page starts at First Setup on a fresh database or Sign In after setup.
4. Log in with username and password.
5. Confirm request totals, token totals, model usage, and recent logs load.
6. Confirm invalid login credentials show an authorization error.
7. For LAN access, set Host to `0.0.0.0`, enable non-localhost bind, restart the server, and open `http://<computer-ip>:1234/` from another device.

## Model Residency Acceptance

1. Set Settings -> `llama-server executable path` to a llama.cpp server binary, for example `/usr/local/bin/llama-server`.
2. Import a local GGUF model from Models.
3. As admin, click `Load` for the model.
4. Confirm the Models page shows the loaded model and runtime port.
5. Call `/v1/chat/completions` using the loaded model name and confirm the request succeeds.
6. Click `Eject` and confirm the loaded model clears.
7. Confirm `/v1/chat/completions` now returns an error asking to load a model first.
8. Confirm `/v1/models` lists only the currently loaded model, or an empty list when no model is loaded.
9. Send malformed JSON to `/v1/chat/completions` and confirm it returns a structured `400` error.
10. Point Settings at a missing `llama-server` path and confirm Load shows a clear setup error.
