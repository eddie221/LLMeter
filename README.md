# LLMeter

A desktop application for running and managing local large language models (LLMs). LLMeter bundles a full HTTP inference server, a multi-user access control system, and a chat interface into a single native app — no cloud required.

Built with **Tauri 2** (Rust backend) and **React + TypeScript** (frontend). Models are loaded via **llama.cpp** in GGUF format.

---

## Features

- **Local inference server** — OpenAI-compatible HTTP API served from your machine, accessible to other tools and scripts
- **Multi-user accounts** — Admin and standard user roles; per-user API keys with label management
- **Chat interface** — Persistent chat sessions organised into projects/groups with rename, duplicate, and export (JSON / Markdown)
- **Model management** — Import GGUF models, configure inference parameters per-load (temperature, top-p, context window, etc.), and monitor loaded state
- **Dashboard** — Real-time charts for token throughput, request counts, and model usage
- **Logs viewer** — Scrollable structured log output from the inference server
- **CLI** — Full admin CLI for headless/scripted control of the server and all resources
- **Collapsible sidebar** — Icon-only collapsed mode to maximise content area

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/start/prerequisites/)

### Development

```bash
npm install
npm run tauri dev
```

### Production build

```bash
npm run tauri build
```

---

## CLI Reference

The same binary that runs the GUI also exposes an admin CLI. Any invocation with arguments is routed to the CLI; bare invocation opens the GUI.

```
llmeter <command> [options]
```

### Global options

| Flag | Env var | Description |
|---|---|---|
| `-u, --username <name>` | `LLMETER_USERNAME` | Admin username |
| `-p, --password <pass>` | `LLMETER_PASSWORD` | Admin password |
| `--db <path>` | `LLMETER_DB` | Override database path |

---

### Server commands

```
llmeter server start [options]    Start the HTTP API server in the background
llmeter server stop               Stop the background server
llmeter server status             Show running state and address
```

**`server start` options**

| Flag | Description |
|---|---|
| `--host <ip>` | Bind address (default: `127.0.0.1`) |
| `--port <n>` | Port number (default: from settings) |
| `--allow-remote` | Allow non-localhost bind addresses |

---

### User commands

```
llmeter user list                 List all users
llmeter user create [options]     Create a new user
llmeter user delete --id <id>     Delete a user
```

**`user create` options**

| Flag | Description |
|---|---|
| `--new-username <u>` | Username (required) |
| `--new-password <p>` | Password (required) |
| `--display-name <n>` | Display name (optional) |
| `--role <r>` | `user` or `admin` (default: `user`) |

---

### Model commands

```
llmeter model list                List imported models
llmeter model import --path <p>   Import a GGUF model file
llmeter model delete --id <id>    Remove a model record
llmeter model load [options]      Load a model into the running server
llmeter model unload [--name <n>] Unload a model (omit --name to unload all)
llmeter model status              Show currently loaded models
```

**`model load` options**

| Flag | Description |
|---|---|
| `--name <n>` | Model name (alternative to `--id`) |
| `--id <id>` | Model ID |
| `--ctx <n>` | Context window size in tokens |
| `--threads <n>` | CPU threads to use |
| `--temperature <f>` | Sampling temperature (e.g. `0.8`) |
| `--top-p <f>` | Top-p nucleus sampling (e.g. `0.95`) |
| `--top-k <n>` | Top-k sampling (e.g. `40`) |
| `--min-p <f>` | Min-p sampling (e.g. `0.05`) |
| `--repeat-penalty <f>` | Repetition penalty (e.g. `1.1`) |
| `--max-tokens <n>` | Maximum response tokens |

---

### API key commands

```
llmeter key list [--user-id <id>]   List API keys
llmeter key create [options]         Create an API key
llmeter key delete --id <id>         Delete an API key
```

**`key create` options**

| Flag | Description |
|---|---|
| `--user-id <id>` | Target user ID (required) |
| `--label <l>` | Key label (required) |

---

## Environment variables

Credentials can be passed via environment variables instead of flags, which is convenient for scripting:

```bash
export LLMETER_USERNAME=admin
export LLMETER_PASSWORD=yourpassword

llmeter server status
llmeter model list
```

---

## License

MIT OR Apache-2.0
