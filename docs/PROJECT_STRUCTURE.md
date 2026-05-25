# Project Structure

LLMeter is a Tauri 2 desktop application. The Rust backend serves a local LLM via llama.cpp and exposes an OpenAI-compatible HTTP API; the React/TypeScript frontend provides the management UI rendered inside the Tauri webview.

---

## Root

```
LLMeter/
├── index.html              # Vite HTML entry point (mounts #root for React)
├── vite.config.ts          # Vite build config (React plugin, Tauri dev server)
├── tsconfig.json           # TypeScript compiler config
├── package.json            # Frontend dependencies & scripts
├── package-lock.json
├── deny.toml               # cargo-deny license/advisory policy
├── .gitignore
├── .cargo/
│   └── config.toml         # Cargo workspace settings (linker flags, etc.)
├── figures/
│   └── icon.png            # Source app icon
├── docs/                   # Project documentation
├── scripts/                # Node utility scripts
└── src-tauri/              # Tauri / Rust backend
    src/                    # React / TypeScript frontend
```

---

## Frontend — `src/`

```
src/
├── main.tsx                # App entry point — all pages, state, and Tauri command calls (~3 200 lines)
├── types.ts                # Shared TypeScript type definitions
├── constants.ts            # App-wide constants (vision pipeline tags, etc.)
├── vite-env.d.ts           # Vite client type references (CSS imports, env vars)
├── components/
│   └── common.tsx          # Shared UI components (ErrorCard, etc.)
├── hooks/
│   └── useAsyncData.ts     # Generic async data-loading hook
├── lib/
│   └── pagination.ts       # Table pagination helpers
└── styles/                 # Modular CSS (loaded via styles/index.css)
    ├── index.css           # @import barrel for all style modules
    ├── base.css            # CSS variables, body reset, utility classes
    ├── auth.css            # Login / register pages, Mantine input/button overrides
    ├── layout.css          # Top bar, tab bar, page shell, content wrappers
    ├── chat.css            # Chat sidebar, messages, composer, markdown renderer
    ├── models.css          # Model cards, load-settings panel, HuggingFace browser
    ├── dashboard.css       # Usage charts, metric cards, date-range picker
    ├── settings.css        # Settings modal, storage path row, settings panel
    └── components.css      # Tables, filter rail, notice/secret cards, bar charts
```

### Frontend dependencies

| Package | Version | Purpose |
|---|---|---|
| react | ^19.2 | UI framework |
| react-dom | ^19.2 | DOM renderer |
| @mantine/core | ^8.3 | Component library |
| @mantine/hooks | ^8.3 | Utility hooks |
| @tauri-apps/api | ^2.10 | Tauri IPC (`invoke`, `listen`, events) |
| bootstrap-icons | ^1.13 | Icon font |

---

## Backend — `src-tauri/src/`

```
src-tauri/src/
├── main.rs             # Binary entry: CLI dispatch → daemon → tauri::run (~22 lines)
├── lib.rs              # Tauri commands, IPC handlers, HuggingFace download logic (~1 630 lines)
├── auth.rs             # Password hashing, JWT-style session tokens, role checks (~50 lines)
├── cli.rs              # CLI command dispatch (user/model/key/server subcommands) (~505 lines)
├── db.rs               # SQLite via rusqlite — models, users, API keys, sessions, usage (~1 065 lines)
├── inference.rs        # Chat completion request/response types, token helpers (~465 lines)
├── llama_bundle.rs     # Resolves bundled llama-server binary path at runtime (~185 lines)
├── model_runtime.rs    # llama-server process lifecycle (start/stop/health) (~396 lines)
├── server.rs           # Axum HTTP server — OpenAI-compatible /v1/ routes (~1 733 lines)
└── types.rs            # Shared Rust types and Serde structs (~265 lines)
```

### Rust dependencies

| Crate | Purpose |
|---|---|
| tauri 2.x | Desktop shell, IPC, file/window APIs |
| axum 0.8 | OpenAI-compatible HTTP server |
| tokio 1.x | Async runtime (multi-thread, signals, process) |
| rusqlite 0.37 (bundled) | SQLite database |
| reqwest 0.12 | HuggingFace API and model downloads |
| serde / serde_json | Serialisation |
| tower-http | CORS middleware for the HTTP server |
| tracing / tracing-subscriber / tracing-appender | Structured logging |
| sha2, rand | Password hashing and token generation |
| base64 | Token encoding |

---

## Backend resources — `src-tauri/`

```
src-tauri/
├── Cargo.toml              # Rust workspace manifest
├── Cargo.lock
├── build.rs                # Tauri build script
├── tauri.conf.json         # App metadata, bundle config, permissions
├── capabilities/
│   └── default.json        # Tauri capability grants (filesystem, shell, etc.)
├── gen/schemas/            # Auto-generated Tauri ACL/capability JSON schemas
├── icons/                  # All platform icon sizes (macOS .icns, Windows .ico, iOS, Android)
├── resources/
│   └── llama/
│       └── darwin-arm64/   # Bundled llama-server + shared libs for macOS ARM
│           ├── bin/llama-server
│           └── lib/*.dylib
└── web/                    # Standalone web dashboard (served headlessly by the daemon)
    ├── index.html
    ├── dashboard.js
    ├── dashboard.css
    └── vendor/bootstrap-icons/
```

---

## Scripts — `scripts/`

```
scripts/
├── llmeter-cli.mjs        # Node wrapper that invokes the Tauri binary as a CLI tool
└── stage-llama-server.mjs  # Copies the correct llama-server build into resources/
```

---

## Docs — `docs/`

```
docs/
├── ARCHITECTURE.md         # System architecture overview
├── CHANGELOG.md            # Version history
├── CLI.md                  # CLI quick-reference
├── CLI_MANUAL.md           # Full CLI manual
├── SPEC.md                 # Feature specification
├── TEST_PLAN.md            # Manual and automated test plan
└── TODO.md                 # Backlog and known issues
```

---

## Data Flow

```
User (GUI)
  └─► React (main.tsx)
        └─► invoke() / listen()          [Tauri IPC]
              └─► lib.rs (Tauri commands)
                    ├─► db.rs            [SQLite — models, users, keys, usage]
                    ├─► model_runtime.rs [llama-server process]
                    └─► server.rs        [Axum HTTP — /v1/chat/completions, etc.]

External Client (curl / OpenAI SDK)
  └─► server.rs (/v1/ routes)
        ├─► auth.rs                      [API key validation]
        └─► model_runtime.rs             [forward to llama-server]
```

---

## Key Architectural Decisions

- **Single binary, three modes** — the Tauri binary acts as a GUI app, a CLI tool (`user`/`model`/`key`/`server` subcommands), or a headless daemon (`--daemon-worker`), selected before Tauri initialises.
- **llama-server as a subprocess** — inference is delegated to a bundled `llama-server` process managed by `model_runtime.rs`. The Tauri process proxies/streams responses.
- **SQLite for all state** — users, API keys, loaded-model config, usage logs, and chat sessions are stored in a single SQLite file under the OS data directory.
- **mmproj auto-download** — when downloading a GGUF from HuggingFace, `fetch_hf_repo_meta` checks the repo for an mmproj file and downloads it automatically after the main model; the file is excluded from the manual download list in the UI.
