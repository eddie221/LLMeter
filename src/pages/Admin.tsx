import { invoke } from '@tauri-apps/api/core';
import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMemo, useState } from 'react';

import type { ApiKeyRecord, CreatedApiKey, UserAccount } from '../types';
import { ErrorCard, Header, TableControls } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';
import { paginateRows } from '../lib/pagination';
import { PasswordRules } from './Auth';

export function AdminPage({ currentUser }: { currentUser: UserAccount }) {
  const users = useAsyncData<UserAccount[]>(() => invoke('list_users', { requesterRole: currentUser.role }), []);
  const keys = useAsyncData<ApiKeyRecord[]>(() => invoke('list_api_keys', { userId: null }), []);
  const [newUser, setNewUser] = useState({ username: '', display_name: '', password: '', role: 'user' as 'admin' | 'user' });
  const [keyUserId, setKeyUserId] = useState<number | null>(null);
  const [keyLabel, setKeyLabel] = useState('Default');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usersShown, setUsersShown] = useState('25');
  const [usersPage, setUsersPage] = useState(0);
  const [apiKeysShown, setApiKeysShown] = useState('25');
  const [apiKeysPage, setApiKeysPage] = useState(0);
  const [adminDeleteTarget, setAdminDeleteTarget] = useState<{ type: 'user'; user: UserAccount } | { type: 'apiKey'; key: ApiKeyRecord } | null>(null);
  const [editUserTarget, setEditUserTarget] = useState<UserAccount | null>(null);
  const [editUserDraft, setEditUserDraft] = useState<{ username: string; display_name: string; role: 'admin' | 'user' }>({ username: '', display_name: '', role: 'user' });
  const [editUserError, setEditUserError] = useState<string | null>(null);
  const userOptions = useMemo(() => (users.data ?? []).map((user) => ({ value: String(user.id), label: `${user.username} (${user.role})` })), [users.data]);
  const refresh = async () => { await users.reload(); await keys.reload(); };
  const createUser = async () => { setError(null); try { await invoke('create_user', { input: newUser, requesterRole: currentUser.role }); setNewUser({ username: '', display_name: '', password: '', role: 'user' }); await refresh(); } catch (err) { setError(String(err)); } };
  const createKey = async () => { if (!keyUserId) return; setError(null); try { const result = await invoke<CreatedApiKey>('create_api_key', { userId: keyUserId, label: keyLabel }); setCreatedKey(result.secret); await refresh(); } catch (err) { setError(String(err)); } };
  const toggleUser = async (user: UserAccount) => { await invoke('update_user', { input: { ...user, enabled: !user.enabled, password: null }, requesterRole: currentUser.role }); await refresh(); };
  const openEditUser = (user: UserAccount) => { setEditUserDraft({ username: user.username, display_name: user.display_name, role: user.role }); setEditUserError(null); setEditUserTarget(user); };
  const saveEditUser = async () => { if (!editUserTarget) return; setEditUserError(null); try { await invoke('update_user', { input: { ...editUserTarget, ...editUserDraft, password: null }, requesterRole: currentUser.role }); setEditUserTarget(null); await refresh(); } catch (err) { setEditUserError(String(err)); } };
  const confirmAdminDelete = async () => {
    if (!adminDeleteTarget) return;
    setError(null);
    try {
      if (adminDeleteTarget.type === 'user') {
        await invoke('delete_user', { userId: adminDeleteTarget.user.id, requesterRole: currentUser.role });
        await refresh();
      } else {
        await invoke('delete_api_key', { keyId: adminDeleteTarget.key.id });
        await keys.reload();
      }
      setAdminDeleteTarget(null);
    } catch (err) {
      setError(String(err));
    }
  };
  const usersPageData = paginateRows(users.data ?? [], usersPage, usersShown);
  const visibleUsers = usersPageData.rows;
  const apiKeysPageData = paginateRows(keys.data ?? [], apiKeysPage, apiKeysShown);
  const visibleApiKeys = apiKeysPageData.rows;
  const adminDeleteTitle = adminDeleteTarget?.type === 'user' ? 'Delete user' : 'Delete API key';
  const adminDeleteDescription = adminDeleteTarget?.type === 'user'
    ? `Delete user "${adminDeleteTarget.user.display_name}" (${adminDeleteTarget.user.username})?`
    : adminDeleteTarget?.type === 'apiKey'
      ? `Delete API key "${adminDeleteTarget.key.label}" for ${adminDeleteTarget.key.display_name ?? adminDeleteTarget.key.username ?? `User ${adminDeleteTarget.key.user_id}`}?`
      : '';
  return <Stack><Header title="Admin" subtitle="Manage accounts and API keys." onRefresh={refresh} />{error || users.error || keys.error ? <ErrorCard message={error ?? users.error ?? keys.error ?? ''} /> : null}{createdKey ? <Card withBorder className="secretCard"><Text fw={700}>New API key. Copy it now; it will not be shown again.</Text><Text className="mono">{createdKey}</Text></Card> : null}<SimpleGrid cols={{ base: 1, md: 2 }}><Card withBorder><Title order={3}>Create user</Title><Stack mt="md"><TextInput label="Username" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.currentTarget.value })} /><TextInput label="True name" value={newUser.display_name} onChange={(e) => setNewUser({ ...newUser, display_name: e.currentTarget.value })} /><PasswordInput label="Password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.currentTarget.value })} /><PasswordRules password={newUser.password} /><Select label="Role" data={['admin', 'user']} value={newUser.role} onChange={(value) => setNewUser({ ...newUser, role: (value ?? 'user') as 'admin' | 'user' })} /><Button onClick={createUser}>Create</Button></Stack></Card><Card withBorder><Title order={3}>Create API key</Title><Stack mt="md"><Select label="User" data={userOptions} value={keyUserId ? String(keyUserId) : null} onChange={(value) => setKeyUserId(value ? Number(value) : null)} /><TextInput label="Label" value={keyLabel} onChange={(e) => setKeyLabel(e.currentTarget.value)} /><Button onClick={createKey} disabled={!keyUserId}>Create key</Button></Stack></Card></SimpleGrid><Card withBorder><Group justify="space-between"><Title order={3}>Users</Title><TableControls shown={usersShown} onShownChange={(value) => { setUsersShown(value); setUsersPage(0); }} page={usersPageData.page} totalPages={usersPageData.totalPages} onPageChange={setUsersPage} /></Group><Table.ScrollContainer minWidth={760}><Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>Username</Table.Th><Table.Th>True name</Table.Th><Table.Th>Role</Table.Th><Table.Th>Enabled</Table.Th><Table.Th>Actions</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visibleUsers.map((user) => <Table.Tr key={user.id}><Table.Td>{user.username}</Table.Td><Table.Td>{user.display_name}</Table.Td><Table.Td><Badge color={user.role === 'admin' ? 'orange' : 'blue'} variant={user.role === 'admin' ? 'light' : 'outline'}>{user.role}</Badge></Table.Td><Table.Td><Switch size="sm" checked={user.enabled} onChange={() => toggleUser(user)} aria-label={user.enabled ? 'Disable user' : 'Enable user'} /></Table.Td><Table.Td><Group gap="xs"><Button size="xs" variant="light" onClick={() => openEditUser(user)}>Edit</Button><Button size="xs" color="red" variant="light" onClick={() => setAdminDeleteTarget({ type: 'user', user })}>Delete</Button></Group></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer></Card><Card withBorder><Group justify="space-between"><Title order={3}>API keys</Title><TableControls shown={apiKeysShown} onShownChange={(value) => { setApiKeysShown(value); setApiKeysPage(0); }} page={apiKeysPageData.page} totalPages={apiKeysPageData.totalPages} onPageChange={setApiKeysPage} /></Group><Table.ScrollContainer minWidth={920}><Table><Table.Thead><Table.Tr><Table.Th>Username</Table.Th><Table.Th>True name</Table.Th><Table.Th>Label</Table.Th><Table.Th>Prefix</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{visibleApiKeys.map((key) => <Table.Tr key={key.id}><Table.Td>{key.username ?? `User ${key.user_id}`}</Table.Td><Table.Td>{key.display_name ?? '-'}</Table.Td><Table.Td>{key.label}</Table.Td><Table.Td>{key.key_prefix}</Table.Td><Table.Td><Button size="xs" color="red" variant="light" onClick={() => setAdminDeleteTarget({ type: 'apiKey', key })}>Delete</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer></Card><Modal opened={Boolean(adminDeleteTarget)} onClose={() => setAdminDeleteTarget(null)} title={adminDeleteTitle} centered><Stack><Text>{adminDeleteDescription}</Text><Text size="sm" c="dimmed">This cannot be undone.</Text><Group justify="end"><Button variant="default" onClick={() => setAdminDeleteTarget(null)}>Cancel</Button><Button color="red" variant="light" onClick={() => void confirmAdminDelete()}>{adminDeleteTarget?.type === 'user' ? 'Delete user' : 'Delete API key'}</Button></Group></Stack></Modal><Modal opened={Boolean(editUserTarget)} onClose={() => setEditUserTarget(null)} title="Edit user" centered><Stack>{editUserError ? <ErrorCard message={editUserError} /> : null}<TextInput label="Username" value={editUserDraft.username} onChange={(e) => setEditUserDraft({ ...editUserDraft, username: e.currentTarget.value })} /><TextInput label="True name" value={editUserDraft.display_name} onChange={(e) => setEditUserDraft({ ...editUserDraft, display_name: e.currentTarget.value })} /><Select label="Role" data={['admin', 'user']} value={editUserDraft.role} onChange={(value) => setEditUserDraft({ ...editUserDraft, role: (value ?? 'user') as 'admin' | 'user' })} /><Group justify="end"><Button variant="default" onClick={() => setEditUserTarget(null)}>Cancel</Button><Button onClick={() => void saveEditUser()}>Save</Button></Group></Stack></Modal></Stack>;
}
