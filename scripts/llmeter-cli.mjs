#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://localhost:1234';
const DEFAULT_WAKE_TIMEOUT_MS = 15000;

function usage() {
  console.log(`LLMeter CLI

Usage:
  llmeter <command> [options]

LM Studio-style commands:
  status                         Show API server and loaded model status
  server status                  Show API server status
  server start                   Wake LLMeter, then start the API server (admin)
  server stop                    Stop the API server, keeping CLI/web control awake (admin)
  ls | models                    List imported local models
  ps | loaded                    List models currently loaded in RAM
  load <model|id> [--ctx-size N] [--threads N]      Load a model into RAM (admin)
  unload [model] | eject [model]                    Eject one loaded model, or all if omitted (admin)
  chat --model <model> --input <text> [--system <prompt>]

Account and dashboard commands:
  login --username <name> --password <password>
  dashboard [--scope all|mine]
  logs [--search <text>]
  users                                              (admin)
  apikeys [--user-id <id>]                           (admin)
  create-user --username <name> --display-name <n> --password <pw> --role user|admin  (admin)
  create-key --user-id <id> [--label <label>]        (admin)
  delete-key --key-id <id>                           (admin)
  delete-user --user-id <id>                         (admin)

Options:
  --base <url>        Server base URL. Default: ${DEFAULT_BASE_URL}
  --token <token>     API key. Can also use LLMETER_API_KEY.
  --json              Print raw JSON where supported.
  --no-wake           Do not launch LLMeter if the service is asleep.
  --wake-timeout <ms> Wait time when waking the app. Default: ${DEFAULT_WAKE_TIMEOUT_MS}

Wake behavior:
  If ${DEFAULT_BASE_URL} is not reachable, the CLI tries to open the LLMeter desktop app,
  then waits for the control service. Set LLMETER_APP_PATH to a specific .app path if needed.

Examples:
  llmeter server start
  llmeter login --username root --password secret
  export LLMETER_API_KEY=ais_...
  llmeter ls
  llmeter load gemma-3-1b-it --ctx-size 4096 --threads 10
  llmeter ps
  llmeter chat --model gemma-3-1b-it --input "Hello"
  llmeter unload gemma-3-1b-it
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function requireValue(args, key) {
  const value = args[key];
  if (!value || value === true) throw new Error(`Missing --${key}`);
  return String(value);
}

function optionalNumber(args, ...keys) {
  for (const key of keys) {
    const value = args[key];
    if (value && value !== true) return Number(value);
  }
  return undefined;
}

function authHeaders(args) {
  const token = args.token || process.env.LLMETER_API_KEY;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function serviceReachable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/web/setup-state`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

function launchApp() {
  if (process.env.LLMETER_APP_COMMAND) {
    const [command, ...parts] = process.env.LLMETER_APP_COMMAND.split(' ').filter(Boolean);
    if (command) spawnSync(command, parts, { detached: true, stdio: 'ignore' });
    return;
  }

  if (process.platform === 'darwin') {
    const candidates = [
      process.env.LLMETER_APP_PATH,
      path.resolve(process.cwd(), 'src-tauri/target/debug/bundle/macos/LLMeter.app'),
      path.resolve(process.cwd(), 'src-tauri/target/release/bundle/macos/LLMeter.app'),
    ].filter(Boolean);
    const appPath = candidates.find(candidate => existsSync(candidate));
    if (appPath) {
      spawnSync('open', [appPath], { stdio: 'ignore' });
    } else {
      spawnSync('open', ['-a', 'LLMeter'], { stdio: 'ignore' });
    }
    return;
  }

  const command = process.env.LLMETER_APP_PATH || 'LLMeter';
  spawnSync(command, [], { detached: true, stdio: 'ignore' });
}

async function wakeService(baseUrl, args) {
  if (await serviceReachable(baseUrl)) return;
  if (args['no-wake']) return;

  if (!args.json) console.error('LLMeter service is asleep. Opening LLMeter...');
  launchApp();

  const timeoutMs = Number(args['wake-timeout'] || process.env.LLMETER_WAKE_TIMEOUT_MS || DEFAULT_WAKE_TIMEOUT_MS);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await serviceReachable(baseUrl)) {
      if (!args.json) console.error('LLMeter service is awake.');
      return;
    }
    await sleep(500);
  }
}

async function request(baseUrl, pathName, args, init = {}, retry = true) {
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(args),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = body?.error?.message ?? body?.message ?? text ?? response.statusText;
      throw new Error(message);
    }
    return body;
  } catch (error) {
    if (!retry || args['no-wake']) throw error;
    await wakeService(baseUrl, args);
    return request(baseUrl, pathName, args, init, false);
  }
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printTable(rows, columns) {
  if (!rows.length) {
    console.log('No rows.');
    return;
  }
  const widths = columns.map(({ key, label }) => Math.max(label.length, ...rows.map(row => String(row[key] ?? '').length)));
  console.log(columns.map(({ label }, index) => label.padEnd(widths[index])).join('  '));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(columns.map(({ key }, index) => String(row[key] ?? '').padEnd(widths[index])).join('  '));
  }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

async function getModelState(baseUrl, args) {
  return request(baseUrl, '/web/models', args);
}

function modelRows(models, loadedModels) {
  const loadedIds = new Set((loadedModels ?? []).filter(model => model.loaded && model.model_id != null).map(model => model.model_id));
  return (models ?? []).map(model => ({
    id: model.id,
    name: model.name,
    format: model.format,
    type: model.model_type ?? 'GGUF · TEXT',
    status: loadedIds.has(model.id) ? 'loaded' : model.status,
    size: formatSize(model.size_bytes),
  }));
}

function loadedRows(loadedModels) {
  return (loadedModels ?? []).filter(model => model.loaded).map(model => ({
    name: model.model_name ?? '-',
    id: model.model_id ?? '-',
    type: model.model_type ?? '-',
    ctx: model.context_length ?? '-',
    threads: model.n_threads ?? '-',
  }));
}

async function printStatus(baseUrl, args) {
  const data = await request(baseUrl, '/web/server', args);
  if (args.json) {
    printJson(data);
    return;
  }
  const status = data.server;
  const loaded = data.loaded_models?.filter(model => model.loaded) ?? [];
  console.log(`API server: ${status?.state ?? 'stopped'} at ${status?.host ?? baseUrl}:${status?.port ?? ''}`);
  console.log('Control service: awake');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Loaded models: ${loaded.length}`);
  for (const model of loaded) console.log(`- ${model.model_name} ctx=${model.context_length ?? '-'} threads=${model.n_threads ?? '-'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let command = args._[0];
  const subcommand = args._[1];
  const baseUrl = String(args.base || process.env.LLMETER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  if (!command || command === 'help' || args.help) {
    usage();
    return;
  }

  if (command === 'server') {
    command = subcommand ? `server:${subcommand}` : 'server:status';
  }

  if (command === 'server:start') {
    await wakeService(baseUrl, args);
    const data = await request(baseUrl, '/web/admin/server/start', args, { method: 'POST', body: '{}' }, false);
    if (args.json) printJson(data);
    else console.log(`LLMeter API server: ${data.server?.state ?? 'running'} at ${baseUrl}`);
    return;
  }

  if (command === 'server:stop') {
    const data = await request(baseUrl, '/web/admin/server/stop', args, { method: 'POST', body: '{}' }, false);
    if (args.json) printJson(data);
    else console.log('LLMeter API server stopped. Control service is still awake for ls/ps.');
    return;
  }

  if (command === 'server:status' || command === 'status') {
    await printStatus(baseUrl, args);
    return;
  }

  if (command === 'login') {
    const username = requireValue(args, 'username');
    const password = requireValue(args, 'password');
    const data = await request(baseUrl, '/web/login', args, { method: 'POST', body: JSON.stringify({ username, password }), headers: {} });
    if (args.json) printJson(data);
    else {
      console.log(`Logged in as ${data.user?.username ?? username}`);
      console.log(`LLMETER_API_KEY=${data.api_key}`);
    }
    return;
  }

  if (command === 'ls' || command === 'models') {
    const data = await getModelState(baseUrl, args);
    if (args.json) printJson(data.models ?? data);
    else printTable(modelRows(data.models, data.loaded_models), [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Model' },
      { key: 'type', label: 'Type' },
      { key: 'format', label: 'Format' },
      { key: 'status', label: 'Status' },
      { key: 'size', label: 'Size' },
    ]);
    return;
  }

  if (command === 'ps' || command === 'loaded') {
    const data = await request(baseUrl, '/web/server', args);
    if (args.json) printJson(data.loaded_models ?? []);
    else printTable(loadedRows(data.loaded_models), [
      { key: 'name', label: 'Loaded model' },
      { key: 'id', label: 'ID' },
      { key: 'type', label: 'Type' },
      { key: 'ctx', label: 'Context' },
      { key: 'threads', label: 'Threads' },
    ]);
    return;
  }

  if (command === 'api-models') {
    const data = await request(baseUrl, '/v1/models', args);
    if (args.json) printJson(data);
    else printTable((data.data ?? []).map(model => ({ id: model.id, object: model.object ?? 'model', owned_by: model.owned_by ?? 'local' })), [
      { key: 'id', label: 'Model' },
      { key: 'object', label: 'Type' },
      { key: 'owned_by', label: 'Owner' },
    ]);
    return;
  }

  if (command === 'load') {
    const target = args._[1] || args.model || args.id;
    if (!target) throw new Error('Usage: llmeter load <model|id> [--ctx-size N] [--threads N]');
    const state = await getModelState(baseUrl, args);
    const models = state.models ?? [];
    const model = models.find(item => String(item.id) === String(target) || item.name === target || path.basename(item.path ?? '') === target);
    if (!model) throw new Error(`Model not found: ${target}`);
    const payload = {
      model_id: model.id,
      context_length: optionalNumber(args, 'ctx-size', 'context-length', 'context'),
      n_threads: optionalNumber(args, 'threads'),
      load_settings: undefined,
    };
    const data = await request(baseUrl, '/web/admin/models/load', args, { method: 'POST', body: JSON.stringify(payload) });
    if (args.json) printJson(data);
    else {
      console.log(`Loaded ${model.name}`);
      printTable(loadedRows(data.loaded_models), [
        { key: 'name', label: 'Loaded model' },
        { key: 'id', label: 'ID' },
        { key: 'ctx', label: 'Context' },
        { key: 'threads', label: 'Threads' },
      ]);
    }
    return;
  }

  if (command === 'unload' || command === 'eject') {
    const modelName = args.all ? null : (args._[1] || args.model || null);
    const data = await request(baseUrl, '/web/admin/models/eject', args, { method: 'POST', body: JSON.stringify({ model_name: modelName }) });
    if (args.json) printJson(data);
    else {
      console.log(modelName ? `Unloaded ${modelName}` : 'Unloaded all models');
      printTable(loadedRows(data.loaded_models), [
        { key: 'name', label: 'Still loaded' },
        { key: 'id', label: 'ID' },
        { key: 'ctx', label: 'Context' },
        { key: 'threads', label: 'Threads' },
      ]);
    }
    return;
  }

  if (command === 'chat') {
    const model = requireValue(args, 'model');
    const input = requireValue(args, 'input');
    const payload = { model, input, system_prompt: args.system || undefined };
    const data = await request(baseUrl, '/api/v1/chat', args, { method: 'POST', body: JSON.stringify(payload) });
    if (args.json) printJson(data);
    else {
      console.log(data.output);
      if (data.usage) console.error(`\nusage: input=${data.usage.input_tokens} output=${data.usage.output_tokens} total=${data.usage.total_tokens}`);
    }
    return;
  }

  if (command === 'dashboard') {
    const scope = args.scope ? `?scope=${encodeURIComponent(String(args.scope))}` : '';
    const data = await request(baseUrl, `/web/dashboard${scope}`, args);
    if (args.json) printJson(data);
    else {
      console.log(`Requests: ${data.request_count ?? 0}`);
      console.log(`Input tokens: ${data.input_tokens ?? 0}`);
      console.log(`Output tokens: ${data.output_tokens ?? 0}`);
      printTable((data.model_usage ?? []).map(row => ({ model: row.model, requests: row.requests, input: row.input_tokens, output: row.output_tokens })), [
        { key: 'model', label: 'Model' },
        { key: 'requests', label: 'Requests' },
        { key: 'input', label: 'Input' },
        { key: 'output', label: 'Output' },
      ]);
    }
    return;
  }

  if (command === 'logs') {
    const search = args.search ? `?search=${encodeURIComponent(String(args.search))}` : '';
    const data = await request(baseUrl, `/web/logs${search}`, args);
    if (args.json) printJson(data);
    else printTable((data ?? []).slice(0, 25).map(log => ({
      time: new Date((log.created_at ?? 0) * 1000).toLocaleString(),
      user: log.display_name ?? log.username ?? '-',
      endpoint: log.endpoint,
      model: log.model ?? '-',
      status: log.status_code,
      tokens: (log.input_tokens ?? 0) + (log.output_tokens ?? 0),
    })), [
      { key: 'time', label: 'Time' },
      { key: 'user', label: 'User' },
      { key: 'endpoint', label: 'Endpoint' },
      { key: 'model', label: 'Model' },
      { key: 'status', label: 'Status' },
      { key: 'tokens', label: 'Tokens' },
    ]);
    return;
  }

  if (command === 'users') {
    const data = await request(baseUrl, '/web/admin', args);
    if (args.json) printJson(data.users ?? data);
    else printTable((data.users ?? []).map(u => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, enabled: u.enabled ? 'yes' : 'no', created: new Date((u.created_at ?? 0) * 1000).toLocaleDateString() })), [
      { key: 'id', label: 'ID' },
      { key: 'username', label: 'Username' },
      { key: 'display_name', label: 'Name' },
      { key: 'role', label: 'Role' },
      { key: 'enabled', label: 'Enabled' },
      { key: 'created', label: 'Created' },
    ]);
    return;
  }

  if (command === 'apikeys') {
    const data = await request(baseUrl, '/web/admin', args);
    const keys = (data.api_keys ?? []).filter(k => !args['user-id'] || String(k.user_id) === String(args['user-id']));
    if (args.json) printJson(keys);
    else printTable(keys.map(k => ({ id: k.id, user: k.display_name ?? k.username ?? `User ${k.user_id}`, label: k.label, prefix: k.key_prefix, created: new Date((k.created_at ?? 0) * 1000).toLocaleDateString() })), [
      { key: 'id', label: 'ID' },
      { key: 'user', label: 'User' },
      { key: 'label', label: 'Label' },
      { key: 'prefix', label: 'Prefix' },
      { key: 'created', label: 'Created' },
    ]);
    return;
  }

  if (command === 'create-user') {
    const username = requireValue(args, 'username');
    const displayName = requireValue(args, 'display-name');
    const password = requireValue(args, 'password');
    const role = args.role && args.role !== true ? String(args.role) : 'user';
    const data = await request(baseUrl, '/web/admin/users', args, { method: 'POST', body: JSON.stringify({ username, display_name: displayName, password, role }) });
    if (args.json) printJson(data);
    else console.log(`Created user: ${data.username} (ID ${data.id}, role: ${data.role})`);
    return;
  }

  if (command === 'create-key') {
    const userId = Number(requireValue(args, 'user-id'));
    const label = args.label && args.label !== true ? String(args.label) : undefined;
    const data = await request(baseUrl, '/web/admin/api-keys', args, { method: 'POST', body: JSON.stringify({ user_id: userId, label }) });
    if (args.json) printJson(data);
    else {
      console.log(`Created API key for user ${userId}: ${data.record?.key_prefix ?? data.key_prefix}...`);
      console.log(`Secret (copy now, shown once): ${data.secret}`);
    }
    return;
  }

  if (command === 'delete-key') {
    const keyId = Number(requireValue(args, 'key-id'));
    const data = await request(baseUrl, '/web/admin/api-keys/delete', args, { method: 'POST', body: JSON.stringify({ key_id: keyId }) });
    if (args.json) printJson(data);
    else console.log(`Deleted API key ${keyId}.`);
    return;
  }

  if (command === 'delete-user') {
    const userId = Number(requireValue(args, 'user-id'));
    const data = await request(baseUrl, '/web/admin/users/delete', args, { method: 'POST', body: JSON.stringify({ user_id: userId }) });
    if (args.json) printJson(data);
    else console.log(`Deleted user ${userId}.`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
