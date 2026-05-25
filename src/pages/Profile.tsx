import { invoke } from '@tauri-apps/api/core';
import {
  Button,
  Card,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';

import type { ApiKeyRecord, CreatedApiKey, UserAccount } from '../types';
import { ErrorCard, Header, TableControls } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';
import { paginateRows } from '../lib/pagination';
import { PasswordRules } from './Auth';

export function ProfilePage({ currentUser, onUpdateUser }: { currentUser: UserAccount; onUpdateUser: (u: UserAccount) => void }) {
  const keys = useAsyncData<ApiKeyRecord[]>(() => invoke('list_api_keys', { userId: currentUser.id }), [currentUser.id]);
  const [username, setUsername] = useState(currentUser.username);
  const [displayName, setDisplayName] = useState(currentUser.display_name);
  const [password, setPassword] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keyDescription, setKeyDescription] = useState('');
  const [profileKeysShown, setProfileKeysShown] = useState('25');
  const [profileKeysPage, setProfileKeysPage] = useState(0);
  const profileKeysPageData = paginateRows(keys.data ?? [], profileKeysPage, profileKeysShown);
  const visibleProfileKeys = profileKeysPageData.rows;

  const saveProfile = async () => {
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await invoke<UserAccount>('update_user', {
        input: { id: currentUser.id, username, display_name: displayName, role: currentUser.role, enabled: currentUser.enabled, password: password || null },
      });
      onUpdateUser(updated);
      setPassword('');
      setSaved(true);
    } catch (err) { setSaveError(String(err)); }
  };

  const createKey = async () => {
    setSaveError(null);
    try {
      const label = keyDescription.trim() || 'Personal key';
      const result = await invoke<CreatedApiKey>('create_api_key', { userId: currentUser.id, label });
      setCreatedKey(result.secret);
      setKeyDescription('');
      setKeyModalOpen(false);
      await keys.reload();
    } catch (err) { setSaveError(String(err)); }
  };

  const deleteApiKey = async (key: ApiKeyRecord) => {
    if (!window.confirm(`Delete API key "${key.label}"? This cannot be undone.`)) return;
    setSaveError(null);
    try {
      await invoke('delete_api_key', { keyId: key.id });
      await keys.reload();
    } catch (err) { setSaveError(String(err)); }
  };

  return (
    <Stack>
      <Header title="Profile" subtitle="Personal account and API keys." onRefresh={keys.reload} />
      {saveError ? <ErrorCard message={saveError} /> : null}
      {saved ? <Card withBorder style={{ borderColor: 'var(--mantine-color-green-6)' }}><Text c="green" size="sm">Profile saved.</Text></Card> : null}
      <Card withBorder>
        <Stack>
          <TextInput label="Username" value={username} onChange={e => setUsername(e.currentTarget.value)} />
          <TextInput label="True name" value={displayName} onChange={e => setDisplayName(e.currentTarget.value)} />
          <PasswordInput label="New password" description="Leave blank to keep current password." value={password} onChange={e => setPassword(e.currentTarget.value)} />
          {password && <PasswordRules password={password} />}
          <Group>
            <Text size="sm" c="dimmed">Role: <Text span c="white">{currentUser.role}</Text></Text>
            <Text size="sm" c="dimmed">User ID: <Text span className="mono" c="white">{currentUser.uid}</Text></Text>
          </Group>
          <Button onClick={saveProfile} disabled={!username.trim() || !displayName.trim()}>Save</Button>
        </Stack>
      </Card>
      {createdKey ? <Card withBorder className="secretCard"><Text fw={700}>New API key. Copy it now; it will not be shown again.</Text><Text className="mono">{createdKey}</Text></Card> : null}
      <Card withBorder>
        <Group justify="space-between">
          <Title order={3}>Personal API keys</Title>
          <TableControls shown={profileKeysShown} onShownChange={(value) => { setProfileKeysShown(value); setProfileKeysPage(0); }} page={profileKeysPageData.page} totalPages={profileKeysPageData.totalPages} onPageChange={setProfileKeysPage}>
            <Button onClick={() => setKeyModalOpen(true)}>Create key</Button>
          </TableControls>
        </Group>
        <Table mt="md">
          <Table.Thead><Table.Tr><Table.Th>Label</Table.Th><Table.Th>Prefix</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>{visibleProfileKeys.map((key) => <Table.Tr key={key.id}><Table.Td>{key.label}</Table.Td><Table.Td>{key.key_prefix}</Table.Td><Table.Td><Button size="xs" color="red" variant="light" onClick={() => void deleteApiKey(key)}>Delete</Button></Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </Card>
      <Modal opened={keyModalOpen} onClose={() => setKeyModalOpen(false)} title="Create API key" centered>
        <Stack>
          <TextInput label="Description" description="Use this to remember where the key will be used." placeholder="Example: Local test app" value={keyDescription} onChange={(e) => setKeyDescription(e.currentTarget.value)} />
          <Group justify="end">
            <Button variant="light" onClick={() => setKeyModalOpen(false)}>Cancel</Button>
            <Button onClick={createKey}>Create key</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
