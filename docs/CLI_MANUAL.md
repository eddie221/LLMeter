# LLMeter CLI Manual

The `llmeter` binary doubles as a command-line administration tool. When the first positional argument is a recognised command group, the application runs headlessly — no GUI window opens.

---

## Table of Contents

- [Authentication](#authentication)
- [Global Options](#global-options)
- [Server Commands](#server-commands)
- [User Commands](#user-commands)
- [Model Commands](#model-commands)
- [API Key Commands](#api-key-commands)
- [Exit Codes](#exit-codes)

---

## Authentication

Every command requires admin credentials. Supply them as flags or environment variables.

### Flags

```bash
llmeter <command> -u <username> -p <password>
# or
llmeter <command> --username <username> --password <password>
```

### Environment variables

```bash
export AISERVER_USERNAME=admin
export AISERVER_PASSWORD=yourpassword
llmeter <command>
```

Using environment variables avoids exposing the password in your shell history.

---

## Global Options

| Flag | Short | Env var | Description |
|------|-------|---------|-------------|
| `--username` | `-u` | `AISERVER_USERNAME` | Admin username |
| `--password` | `-p` | `AISERVER_PASSWORD` | Admin password |
| `--db` | | `AISERVER_DB` | Override the database file path |
| `--help` | `-h` | | Print help and exit |

### Default database path

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.local.llmeter/llmeter.sqlite` |
| Linux | `~/.local/share/com.local.llmeter/llmeter.sqlite` |
| Windows | `%APPDATA%\com.local.llmeter\llmeter.sqlite` |

---

## Server Commands

Start, stop, and inspect the background HTTP API server without opening the GUI.

### `server start`

Spawns the HTTP API server as a background process and returns immediately.

```bash
llmeter server start -u <username> -p <password>
```

**Output:**
```
server started (pid=12345) → http://127.0.0.1:1234
```

If the server is already running the command reports it without starting a second instance:
```
server already running (pid=12345) → http://127.0.0.1:1234
```

The server process runs silently with no terminal output. A PID file is written to the same directory as the database (`llmeter-daemon.pid`).

---

### `server stop`

Sends SIGTERM to the background server and removes the PID file.

```bash
llmeter server stop -u <username> -p <password>
```

**Output:**
```
server stopped (pid=12345)
```

---

### `server status`

Shows whether the server is running, its PID, and its configured address.

```bash
llmeter server status -u <username> -p <password>
```

**Output (running):**
```
running  pid=12345  http://127.0.0.1:1234
```

**Output (stopped):**
```
stopped  configured: 127.0.0.1:1234
```

---

## User Commands

### `user list`

Lists all user accounts.

```bash
llmeter user list -u <username> -p <password>
```

**Output:**
```
ID     Username             Display Name              Role     Enabled
────────────────────────────────────────────────────────────────────
1      admin                Administrator             admin    yes
2      alice                Alice Smith               user     yes
3      bob                  Bob Jones                 user     no
```

---

### `user create`

Creates a new user account.

```bash
llmeter user create -u <username> -p <password> \
  --new-username <u> \
  --new-password <p> \
  [--display-name <n>] \
  [--role user|admin]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--new-username` | Yes | | Login username for the new account |
| `--new-password` | Yes | | Password (must meet strength requirements) |
| `--display-name` | No | same as username | Human-readable name |
| `--role` | No | `user` | Role: `user` or `admin` |

**Password requirements:** 12+ characters, uppercase, lowercase, number, and symbol.

**Example:**
```bash
llmeter user create -u admin -p adminpass \
  --new-username alice \
  --new-password "Str0ng!Pass#2024" \
  --display-name "Alice Smith" \
  --role user
```

**Output:**
```
created user 'alice' (id=2)
```

---

### `user delete`

Permanently deletes a user account, all their API keys, and their request logs.

```bash
llmeter user delete -u <username> -p <password> --id <id>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--id` / `-i` | Yes | ID of the user to delete (from `user list`) |

**Example:**
```bash
llmeter user delete -u admin -p adminpass --id 3
```

**Output:**
```
deleted user id=3
```

---

## Model Commands

### `model list`

Lists all imported model records.

```bash
llmeter model list -u <username> -p <password>
```

**Output:**
```
ID     Name                                     Format   Status
──────────────────────────────────────────────────────────────
1      llama-3.2-3b-instruct-q8_0              gguf     ready
2      mistral-7b-instruct-v0.2-q4_k_m         gguf     ready
```

---

### `model import`

Registers a local GGUF file as an importable model.

```bash
llmeter model import -u <username> -p <password> --path <path>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--path` / `-f` | Yes | Absolute path to the `.gguf` file |

**Example:**
```bash
llmeter model import -u admin -p adminpass \
  --path /Users/you/models/llama-3.2-3b-q8_0.gguf
```

**Output:**
```
imported model 'llama-3.2-3b-q8_0' (id=1)
```

---

### `model delete`

Removes a model record from the database (does not delete the file on disk).

```bash
llmeter model delete -u <username> -p <password> --id <id>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--id` / `-i` | Yes | ID of the model to remove (from `model list`) |

**Example:**
```bash
llmeter model delete -u admin -p adminpass --id 2
```

**Output:**
```
deleted model id=2
```

---

## API Key Commands

### `key list`

Lists API keys. Optionally filtered to a single user.

```bash
llmeter key list -u <username> -p <password> [--user-id <id>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--user-id` / `-i` | No | Filter to keys belonging to this user ID |

**Output:**
```
ID     Prefix           User                      Label                Enabled
────────────────────────────────────────────────────────────────────────
1      ais_3f7a92b1c4   alice                     production           yes
2      ais_88d1e0fa22   alice                     dev-local            yes
3      ais_cc4590b7d3   bob                       my-app               no
```

---

### `key create`

Creates a new API key for a user. **The full key is shown only once.**

```bash
llmeter key create -u <username> -p <password> \
  --user-id <id> \
  --label <label>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--user-id` / `-i` | Yes | ID of the user to create the key for |
| `--label` / `-l` | Yes | Human-readable label for the key |

**Example:**
```bash
llmeter key create -u admin -p adminpass \
  --user-id 2 \
  --label "production"
```

**Output:**
```
created API key for user id=2
  label  : production
  prefix : ais_3f7a92b1
  key    : ais_3f7a92b1c4e5d6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f
  (save this key — it will not be shown again)
```

---

### `key delete`

Revokes and permanently deletes an API key.

```bash
llmeter key delete -u <username> -p <password> --id <id>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--id` / `-i` | Yes | ID of the key to delete (from `key list`) |

**Example:**
```bash
llmeter key delete -u admin -p adminpass --id 3
```

**Output:**
```
deleted API key id=3
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Command completed successfully |
| `1` | Error — message printed to stderr |
