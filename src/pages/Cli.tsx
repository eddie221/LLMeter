import { invoke } from '@tauri-apps/api/core';
import {
  Accordion,
  ActionIcon,
  Badge,
  Card,
  Code,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useState } from 'react';

import { Bi } from '../components/Bi';
import { Header } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';

type CliOption = { flag: string; description: string; required?: boolean };
type CliCommand = {
  syntax: string;
  description: string;
  options?: CliOption[];
  example: string;
};
type CliGroup = {
  id: string;
  label: string;
  description: string;
  commands: CliCommand[];
};

const CLI_GROUPS: CliGroup[] = [
  {
    id: 'server',
    label: 'Server',
    description: 'Start, stop, and inspect the background HTTP API server.',
    commands: [
      {
        syntax: 'llmeter server start',
        description: 'Start the HTTP API server as a background process.',
        options: [
          { flag: '--host <ip>', description: 'Bind address (default: 127.0.0.1)' },
          { flag: '--port <n>', description: 'Port number (default: from saved settings)' },
          { flag: '--allow-remote', description: 'Allow non-localhost bind addresses' },
        ],
        example: 'llmeter -u admin -p secret server start --port 8080 --allow-remote',
      },
      {
        syntax: 'llmeter server stop',
        description: 'Send SIGTERM to the running server process.',
        example: 'llmeter -u admin -p secret server stop',
      },
      {
        syntax: 'llmeter server status',
        description: 'Show whether the server is running, its PID, and its address.',
        example: 'llmeter -u admin -p secret server status',
      },
    ],
  },
  {
    id: 'user',
    label: 'User',
    description: 'Create, list, and delete user accounts.',
    commands: [
      {
        syntax: 'llmeter user list',
        description: 'Print all user accounts with their ID, username, role, and enabled status.',
        example: 'llmeter -u admin -p secret user list',
      },
      {
        syntax: 'llmeter user create',
        description: 'Create a new user account.',
        options: [
          { flag: '--new-username <u>', description: 'Username for the new account', required: true },
          { flag: '--new-password <p>', description: 'Password for the new account', required: true },
          { flag: '--display-name <n>', description: 'Display name (defaults to username)' },
          { flag: '--role <r>', description: 'Role: user | admin (default: user)' },
        ],
        example: 'llmeter -u admin -p secret user create --new-username alice --new-password "S3cur3!" --role user',
      },
      {
        syntax: 'llmeter user delete',
        description: 'Permanently delete a user account by ID.',
        options: [
          { flag: '--id <id>', description: 'ID of the user to delete', required: true },
        ],
        example: 'llmeter -u admin -p secret user delete --id 3',
      },
    ],
  },
  {
    id: 'model',
    label: 'Model',
    description: 'Import, list, load, unload, and delete models.',
    commands: [
      {
        syntax: 'llmeter model list',
        description: 'List all imported models with their ID, name, format, and status.',
        example: 'llmeter -u admin -p secret model list',
      },
      {
        syntax: 'llmeter model import',
        description: 'Import a GGUF model file into the model store.',
        options: [
          { flag: '--path <p>', description: 'Absolute path to the .gguf file', required: true },
        ],
        example: 'llmeter -u admin -p secret model import --path /models/mistral-7b.gguf',
      },
      {
        syntax: 'llmeter model delete',
        description: 'Remove a model record (does not delete the file on disk).',
        options: [
          { flag: '--id <id>', description: 'ID of the model to delete', required: true },
        ],
        example: 'llmeter -u admin -p secret model delete --id 2',
      },
      {
        syntax: 'llmeter model load',
        description: 'Load a model into the running server. Requires the server to be started.',
        options: [
          { flag: '--name <n>', description: 'Model name (use instead of --id)' },
          { flag: '--id <id>', description: 'Model ID' },
          { flag: '--ctx <n>', description: 'Context window size in tokens' },
          { flag: '--threads <n>', description: 'CPU threads to use' },
          { flag: '--temperature <f>', description: 'Sampling temperature (e.g. 0.8)' },
          { flag: '--top-p <f>', description: 'Top-p nucleus sampling (e.g. 0.95)' },
          { flag: '--top-k <n>', description: 'Top-k sampling (e.g. 40)' },
          { flag: '--min-p <f>', description: 'Min-p sampling (e.g. 0.05)' },
          { flag: '--repeat-penalty <f>', description: 'Repetition penalty (e.g. 1.1)' },
          { flag: '--max-tokens <n>', description: 'Max response tokens' },
        ],
        example: 'llmeter -u admin -p secret model load --name mistral-7b --ctx 4096 --threads 8',
      },
      {
        syntax: 'llmeter model unload',
        description: 'Unload a named model from the server, or all models if --name is omitted.',
        options: [
          { flag: '--name <n>', description: 'Name of the model to unload (omit to unload all)' },
        ],
        example: 'llmeter -u admin -p secret model unload --name mistral-7b',
      },
      {
        syntax: 'llmeter model status',
        description: 'Show currently loaded models with their port and context length.',
        example: 'llmeter -u admin -p secret model status',
      },
    ],
  },
  {
    id: 'key',
    label: 'API Key',
    description: 'Create, list, and revoke API keys for accessing the HTTP server.',
    commands: [
      {
        syntax: 'llmeter key list',
        description: 'List API keys, optionally filtered to a specific user.',
        options: [
          { flag: '--user-id <id>', description: 'Filter keys by user ID' },
          { flag: '--username <u>', description: 'Filter keys by username (case-insensitive, use instead of --user-id)' },
        ],
        example: 'llmeter -u admin -p secret key list --username alice',
      },
      {
        syntax: 'llmeter key create',
        description: 'Create a new API key for a user. The secret is shown once.',
        options: [
          { flag: '--user-id <id>', description: 'Target user ID', required: true },
          { flag: '--label <l>', description: 'Descriptive label for the key', required: true },
        ],
        example: 'llmeter -u admin -p secret key create --user-id 2 --label "CI pipeline"',
      },
      {
        syntax: 'llmeter key delete',
        description: 'Revoke and delete an API key by ID.',
        options: [
          { flag: '--id <id>', description: 'ID of the API key to delete', required: true },
        ],
        example: 'llmeter -u admin -p secret key delete --id 5',
      },
    ],
  },
];

const GLOBAL_OPTIONS: CliOption[] = [
  { flag: '-u, --username <name>', description: 'Admin username (or set LLMETER_USERNAME env var)' },
  { flag: '-p, --password <pass>', description: 'Admin password (or set LLMETER_PASSWORD env var)' },
  { flag: '--db <path>', description: 'Override the database path (or set LLMETER_DB env var)' },
  { flag: '-V, --version', description: 'Print the llmeter version and exit' },
  { flag: '-h, --help', description: 'Print help and exit' },
];

function OptionRow({ opt }: { opt: CliOption }) {
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap" className="cliOptionRow">
      <Code className="cliFlag">{opt.flag}</Code>
      <Text size="sm" c="dimmed" style={{ flex: 1 }}>{opt.description}</Text>
      {opt.required && <Badge size="xs" color="red" variant="light">required</Badge>}
    </Group>
  );
}

function CommandCard({ cmd }: { cmd: CliCommand }) {
  return (
    <Card withBorder className="cliCommandCard">
      <Stack gap="xs">
        <Code block className="cliSyntax">{cmd.syntax}</Code>
        <Text size="sm">{cmd.description}</Text>
        {cmd.options && cmd.options.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">Options</Text>
            {cmd.options.map((opt) => <OptionRow key={opt.flag} opt={opt} />)}
          </Stack>
        )}
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">Example</Text>
          <Code block className="cliExample">{cmd.example}</Code>
        </Stack>
      </Stack>
    </Card>
  );
}

function BinaryPathCard() {
  const { data: binaryPath } = useAsyncData<string | null>(() => invoke('get_cli_binary_path'), []);
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Card withBorder className="noticeCard info">
      <Stack gap="xs">
        <Text fw={600} size="sm">Running the CLI</Text>
        {binaryPath === null ? (
          <Text size="sm" c="dimmed">
            Binary path is not available in development mode. In a production build the full path to the LLMeter binary will appear here.
          </Text>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              The CLI is built into the LLMeter binary. The app binary is not on your PATH by default.
              Use the full path below, or create a shell alias so you can run it as <Code>llmeter</Code>.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Code style={{ flex: 1, wordBreak: 'break-all' }}>{binaryPath}</Code>
              <Tooltip label={copied ? 'Copied!' : 'Copy path'} withArrow>
                <ActionIcon variant="light" size="lg" onClick={() => copy(binaryPath)}>
                  <Bi name={copied ? 'check-lg' : 'clipboard'} />
                </ActionIcon>
              </Tooltip>
            </Group>
            <Text size="xs" c="dimmed">
              Example alias — add to <Code>~/.zshrc</Code> or <Code>~/.bashrc</Code>:{' '}
              <Code>{`alias llmeter='${binaryPath}'`}</Code>
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}

export function CliPage() {
  return (
    <Stack>
      <Header title="CLI Reference" subtitle="Admin-only command-line interface for managing LLMeter" />

      <BinaryPathCard />

      <Card withBorder className="cliGlobalCard">
        <Stack gap="xs">
          <Text fw={600} size="sm">Global Options</Text>
          <Text size="xs" c="dimmed">These flags apply to every command and can also be set via environment variables.</Text>
          {GLOBAL_OPTIONS.map((opt) => <OptionRow key={opt.flag} opt={opt} />)}
        </Stack>
      </Card>

      <Accordion multiple variant="separated" defaultValue={['server']}>
        {CLI_GROUPS.map((group) => (
          <Accordion.Item key={group.id} value={group.id}>
            <Accordion.Control>
              <Group gap="sm">
                <Text fw={600}>{group.label}</Text>
                <Badge size="xs" variant="light" color="blue">{group.commands.length} commands</Badge>
              </Group>
              <Text size="xs" c="dimmed">{group.description}</Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                {group.commands.map((cmd) => <CommandCard key={cmd.syntax} cmd={cmd} />)}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}
