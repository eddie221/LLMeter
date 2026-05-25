import { invoke } from '@tauri-apps/api/core';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import React, { useState } from 'react';

import type { RequestLogRecord, UserAccount } from '../types';
import { EmptyState, ErrorCard, Header, TableControls } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';
import { paginateRows } from '../lib/pagination';
import { formatDate } from '../lib/format';

const LOG_MODULE_PALETTE = ['#14b8a6', '#4285f4', '#9b5cf6', '#f2418f', '#ff8a33', '#a3e635', '#38bdf8', '#fb7185', '#facc15', '#818cf8'];

export function hashModuleColor(module: string): string {
  let h = 0;
  for (let i = 0; i < module.length; i++) h = (h * 31 + module.charCodeAt(i)) >>> 0;
  return LOG_MODULE_PALETTE[h % LOG_MODULE_PALETTE.length];
}

export function logLineColor(line: string): string {
  if (line.startsWith('$ ')) return '#7dd3fc';
  if (line.startsWith('> ')) return '#a78bfa';
  if (line.startsWith('< 2')) return '#6ee7b7';
  if (line.startsWith('< 4') || line.startsWith('< 5')) return '#f87171';
  if (/error/i.test(line)) return '#f87171';
  if (/warn/i.test(line)) return '#fbbf24';
  if (/\bdebug\b/i.test(line)) return '#6b7280';
  return '#9ca3af';
}

export function renderLogLine(line: string): React.ReactNode {
  const match = line.match(/^(\[[^\]]+\])\s*([\s\S]*)$/);
  if (!match) return <span style={{ color: logLineColor(line) }}>{line}</span>;
  const [, tag, rest] = match;
  const module = tag.slice(1, -1);
  return (
    <>
      <span style={{ color: hashModuleColor(module), fontWeight: 700 }}>{tag}</span>
      {rest ? <span style={{ color: logLineColor(rest) }}>{' '}{rest}</span> : null}
    </>
  );
}

export function LogsPage({ currentUser }: { currentUser: UserAccount }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<RequestLogRecord | null>(null);
  const [logsShown, setLogsShown] = useState('25');
  const [logsPage, setLogsPage] = useState(0);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(['time', 'userId', 'username', 'endpoint', 'model', 'key', 'tokens', 'status', 'details']);
  const { data, error, reload } = useAsyncData<RequestLogRecord[]>(() => invoke('list_logs', { search, requesterUserId: currentUser.id, requesterRole: currentUser.role }), [search, currentUser.id, currentUser.role]);
  const logsPageData = paginateRows(data ?? [], logsPage, logsShown);
  const visibleLogs = logsPageData.rows;
  const hasColumn = (key: string) => visibleColumns.includes(key);
  const logColumnOptions = [
    { value: 'time', label: 'Time' },
    { value: 'userId', label: 'True Name' },
    { value: 'username', label: 'Username' },
    { value: 'endpoint', label: 'Endpoint' },
    { value: 'model', label: 'Model' },
    { value: 'key', label: 'Key' },
    { value: 'tokens', label: 'Tokens' },
    { value: 'status', label: 'Status' },
    { value: 'details', label: 'Details' },
  ];

  return <Stack>
    <Header title="Logs" subtitle="Search prompts, outputs, token counts, and API key prefixes." onRefresh={reload} />
    {error ? <ErrorCard message={error} /> : null}
    <Group align="end">
      <TextInput label="Search" value={search} onChange={(e) => { setSearch(e.currentTarget.value); setLogsPage(0); }} className="grow" />
      <TableControls shown={logsShown} onShownChange={(value) => { setLogsShown(value); setLogsPage(0); }} page={logsPageData.page} totalPages={logsPageData.totalPages} onPageChange={setLogsPage} />
    </Group>
    <Card withBorder>
      <Stack gap="xs">
        <Text size="sm" c="dimmed" fw={700}>Columns</Text>
        <Checkbox.Group value={visibleColumns} onChange={setVisibleColumns}>
          <Group gap="md">
            {logColumnOptions.map(option => <Checkbox key={option.value} value={option.value} label={option.label} />)}
          </Group>
        </Checkbox.Group>
      </Stack>
    </Card>
    <Card withBorder>
      <Table.ScrollContainer minWidth={980}>
        <Table highlightOnHover className="centeredLogTable">
          <Table.Thead><Table.Tr>
            {hasColumn('time') ? <Table.Th>Time</Table.Th> : null}
            {hasColumn('userId') ? <Table.Th>User</Table.Th> : null}
            {hasColumn('username') ? <Table.Th>Username</Table.Th> : null}
            {hasColumn('endpoint') ? <Table.Th>Endpoint</Table.Th> : null}
            {hasColumn('model') ? <Table.Th>Model</Table.Th> : null}
            {hasColumn('key') ? <Table.Th>Key</Table.Th> : null}
            {hasColumn('tokens') ? <Table.Th>Tokens</Table.Th> : null}
            {hasColumn('status') ? <Table.Th>Status</Table.Th> : null}
            {hasColumn('details') ? <Table.Th /> : null}
          </Table.Tr></Table.Thead>
          <Table.Tbody>{visibleLogs.map((log) => <Table.Tr key={log.id}>
            {hasColumn('time') ? <Table.Td>{formatDate(log.created_at)}</Table.Td> : null}
            {hasColumn('userId') ? <Table.Td>{log.display_name ?? '-'}</Table.Td> : null}
            {hasColumn('username') ? <Table.Td>{log.username ?? '-'}</Table.Td> : null}
            {hasColumn('endpoint') ? <Table.Td>{log.endpoint}</Table.Td> : null}
            {hasColumn('model') ? <Table.Td>{log.model ?? '-'}</Table.Td> : null}
            {hasColumn('key') ? <Table.Td>{log.api_key_prefix}</Table.Td> : null}
            {hasColumn('tokens') ? <Table.Td>{log.input_tokens}/{log.output_tokens}</Table.Td> : null}
            {hasColumn('status') ? <Table.Td><Badge color={log.status_code < 400 ? 'green' : 'red'}>{log.status_code}</Badge></Table.Td> : null}
            {hasColumn('details') ? <Table.Td><Button size="xs" variant="light" onClick={() => setSelected(log)}>Details</Button></Table.Td> : null}
          </Table.Tr>)}</Table.Tbody>
        </Table>
	      </Table.ScrollContainer>
	      {visibleLogs.length === 0 ? <EmptyState title="No logs found" description={search.trim() ? 'Try a different search term, or clear the search box to see all logs.' : 'Requests and desktop chat executions will appear here after clients call the API or users chat with a model.'} compact /> : null}
	    </Card>
    <Modal opened={selected !== null} onClose={() => setSelected(null)} title="Prompt detail" size="xl">
      {selected ? <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Time</Text><Text>{formatDate(selected.created_at)}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>User</Text><Text>{selected.display_name ?? '-'}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Username</Text><Text>{selected.username ?? '-'}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Endpoint</Text><Text>{selected.endpoint}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Model</Text><Text>{selected.model ?? '-'}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Key</Text><Text>{selected.api_key_prefix}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Input tokens</Text><Text>{selected.input_tokens.toLocaleString()}</Text></Card>
          <Card withBorder><Text size="xs" c="dimmed" tt="uppercase" fw={800}>Output tokens</Text><Text>{selected.output_tokens.toLocaleString()}</Text></Card>
        </SimpleGrid>
        <Textarea label="Input" autosize minRows={5} value={selected.input_text} readOnly />
        <Textarea label="Output" autosize minRows={5} value={selected.output_text} readOnly />
        {selected.error_message ? <ErrorCard message={selected.error_message} /> : null}
      </Stack> : null}
    </Modal>
  </Stack>;
}
