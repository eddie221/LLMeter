# LLMeter CLI

The CLI is designed to feel close to LM Studio's local workflow. Commands start with `llmeter`, and if the lightweight control service is asleep the CLI will try to open the LLMeter desktop app and wait for that service to wake. Listing models and loaded processes does not start the model API server.

Install/link the local command once from this project folder:

```bash
npm link
```

If you do not link it, use the development fallback:

```bash
npm run cli -- help
```

Default service URL:

```text
http://localhost:1234
```

## First use

Wake the app and start the API server:

```bash
llmeter server start
```

Log in and copy the printed token:

```bash
llmeter login --username root --password secret
export AISERVER_API_KEY="ais_..."
```

## LM Studio-style commands

```bash
llmeter status                    # API server state + loaded models
llmeter server status             # same, explicit server namespace
llmeter server start              # wake/open LLMeter and start the API server
llmeter server stop               # stop API server; control service stays awake

llmeter ls                        # list imported local models; API server not required
llmeter models                    # alias for ls
llmeter ps                        # list models loaded in RAM; API server not required
llmeter loaded                    # alias for ps

llmeter load gemma-3-1b-it --ctx-size 4096 --threads 10
llmeter unload gemma-3-1b-it
llmeter unload --all

llmeter chat --model gemma-3-1b-it --input "Hello"
```

## Other useful commands

```bash
llmeter dashboard --scope mine
llmeter logs --search gemma
llmeter users
llmeter apikeys
llmeter create-user --username bor --display-name "Bor" --password secret --role user
llmeter create-key --user-id 2 --label "My app"
llmeter delete-key --key-id 3
llmeter delete-user --user-id 2
```

## Options

Use another server URL:

```bash
AISERVER_BASE_URL="http://127.0.0.1:1234" llmeter ls
```

Raw JSON output:

```bash
llmeter ls --json
```

Disable wakeup behavior:

```bash
llmeter status --no-wake
```

If the app is not installed under the normal macOS app name, point the CLI to the app bundle:

```bash
AISERVER_APP_PATH="/path/to/LLMeter.app" llmeter server start
```
