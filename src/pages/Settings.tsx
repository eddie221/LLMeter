import { invoke } from '@tauri-apps/api/core';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useEffect, useState } from 'react';

import type { AppStorageDirs, ServerStatus, SettingsRecord, UserAccount } from '../types';
import { Bi } from '../components/Bi';
import { ErrorCard, Header } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';

/** Opens a path in the system file manager. For file paths, opens the parent folder. */
function openInFinder(path: string) {
  if (!path) return;
  // If the path looks like a file (has an extension after the last separator), open parent dir.
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const lastName = path.slice(lastSep + 1);
  const isFile = lastName.includes('.');
  const target = isFile ? path.slice(0, lastSep) || path : path;
  void invoke('open_external_url', { url: `file://${target}` });
}


export function SettingsPanel({ currentUser, onSaved }: { currentUser: UserAccount; onSaved?: () => void | Promise<void> }) {
  const { data, error, reload } = useAsyncData<SettingsRecord>(() => invoke('get_settings', { requesterRole: currentUser.role }), [currentUser.role]);
  const serverStatus = useAsyncData<ServerStatus>(() => invoke('get_public_server_status'), []);
  const [settings, setSettings] = useState<SettingsRecord | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  useEffect(() => { if (data) setSettings(data); }, [data]);
  const updateSettings = (next: SettingsRecord) => { setSettings(next); setSaved(false); };
  const save = async () => {
    if (!settings) return;
    setSaveError(null);
    setSaved(false);
    const prevHost = data?.host;
    const prevPort = data?.port;
    try {
      const savedSettings = await invoke<SettingsRecord>('save_settings', { input: settings, requesterRole: currentUser.role });
      setSettings(savedSettings);
      setSaved(true);
      const addressChanged = savedSettings.host !== prevHost || savedSettings.port !== prevPort;
      const isRunning = serverStatus.data?.state === 'running';
      setNeedsRestart(addressChanged && isRunning);
      await reload();
      await onSaved?.();
    } catch (err) {
      setSaveError(String(err));
    }
  };
  return (
    <Stack className="settingsPanel">
      {error || saveError ? <ErrorCard message={error ?? saveError ?? ''} /> : null}
      {saved ? <Card withBorder className="settingsSaved"><Text c="green" size="sm">Settings saved.</Text></Card> : null}
      {needsRestart ? (
        <Card withBorder className="noticeCard info">
          <Text size="sm">Server address changed — restart the server for the new address to take effect.</Text>
        </Card>
      ) : null}
      {settings ? (
        <Stack gap="md">
          <Card withBorder className="settingsSection">
            <Text className="settingsSectionLabel">Network</Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Host" value={settings.host} onChange={(e) => updateSettings({ ...settings, host: e.currentTarget.value })} />
              <NumberInput label="Port" min={1} max={65535} value={settings.port} onChange={(value) => updateSettings({ ...settings, port: Number(value) })} />
            </SimpleGrid>
            <Switch className="settingsSwitchAfterInputs" color="green" label="Allow non-localhost bind" checked={settings.allow_non_localhost} onChange={(e) => updateSettings({ ...settings, allow_non_localhost: e.currentTarget.checked })} />
          </Card>

          <Card withBorder className="settingsSection">
            <Text className="settingsSectionLabel">Access</Text>
            <Switch color="green" label="Require API key for /v1/ endpoints" description={settings.require_api_key ? 'Clients must send a valid Bearer token. Disable for open access.' : 'Open access - no API key required. Enable to restrict access.'} checked={settings.require_api_key} onChange={(e) => updateSettings({ ...settings, require_api_key: e.currentTarget.checked })} />
          </Card>
          <Group justify="space-between" className="settingsActions">
            <Button variant="light" onClick={reload}>Refresh</Button>
            <Button onClick={save}>Save settings</Button>
          </Group>
        </Stack>
      ) : <Text c="dimmed">Loading settings...</Text>}
    </Stack>
  );
}

export function ApplicationSettingsPage({ currentUser }: { currentUser: UserAccount }) {
  const { data, error, reload } = useAsyncData<AppStorageDirs>(
    () => invoke('get_app_storage_dirs', { requesterRole: currentUser.role }),
    [currentUser.role],
    currentUser.role === 'admin',
  );
  const [copied, setCopied] = useState<string | null>(null);
  const copyPath = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1600);
  };
  const rows = data ? [
    { label: 'Model folder', value: data.model_store_dir, description: 'Imported GGUF files are copied here.' },
    { label: 'Hugging Face cache', value: data.hf_cache_dir, description: 'Original Hugging Face model files are staged here before GGUF conversion.' },
    { label: 'Session folder', value: data.session_store_dir, description: 'Chat groups are stored here as user_<unique-id>/group subfolders with one JSON file per session.' },
    { label: 'Database', value: data.database_path, description: 'SQLite database for users, API keys, models, logs, and server settings.' },
    { label: 'Application data', value: data.app_data_dir, description: 'Root folder managed by the desktop application.' },
  ] : [];

  return (
    <Stack>
      <Header title="Settings" subtitle="Application storage locations" onRefresh={reload} />
      {error ? <ErrorCard message={error} /> : null}
      {copied ? <Card withBorder className="settingsSaved"><Text c="green" size="sm">{copied} copied.</Text></Card> : null}
      <Card withBorder className="appSettingsCard">
        <Stack gap="md">
          <div>
            <Text className="settingsSectionLabel">Storage</Text>
            <Text c="dimmed" size="sm">These paths are created inside the Tauri app-data directory. Changing them safely will require a migration step, so this page currently shows the active locations.</Text>
          </div>
          {data ? rows.map(row => (
            <div key={row.label} className="storagePathRow">
              <div className="storagePathText">
                <Text fw={800} size="sm">{row.label}</Text>
                <Text c="dimmed" size="xs">{row.description}</Text>
              </div>
              <Group gap="xs" wrap="nowrap" className="storagePathValue">
                <TextInput readOnly value={row.value} className="mono" />
                <Tooltip label="Copy path" withArrow>
                  <ActionIcon variant="light" size="lg" onClick={() => copyPath(row.label, row.value)}>
                    <Bi name={copied === row.label ? 'check-lg' : 'clipboard'} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Reveal in Finder" withArrow>
                  <ActionIcon variant="default" size="lg" onClick={() => openInFinder(row.value)}>
                    <Bi name="folder2-open" />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </div>
          )) : <Text c="dimmed">Loading storage settings...</Text>}
        </Stack>
      </Card>
    </Stack>
  );
}
