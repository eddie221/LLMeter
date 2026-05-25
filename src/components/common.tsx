import { Button, Card, Group, Select, Stack, Text, Title } from '@mantine/core';
import type React from 'react';
import { shownNumberOptions } from '../constants';

function TablePager({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  return (
    <Group justify="end" gap="sm" className="tablePager">
      <Button size="xs" variant="light" disabled={page <= 0} onClick={() => onPageChange(page - 1)}>Previous</Button>
      <Text size="sm" c="dimmed">Page {page + 1} / {totalPages}</Text>
      <Button size="xs" variant="light" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>Next</Button>
    </Group>
  );
}

export function TableControls({ shown, onShownChange, page, totalPages, onPageChange, children }: { shown: string; onShownChange: (value: string) => void; page: number; totalPages: number; onPageChange: (page: number) => void; children?: React.ReactNode }) {
  return (
    <Group align="end" gap="sm" className="tableControls">
      {children}
      <Select label="Rows" size="xs" w={96} data={shownNumberOptions} value={shown} onChange={(value) => onShownChange(value ?? '25')} />
      <TablePager page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </Group>
  );
}

export function Header({ title, subtitle, onRefresh }: { title: string; subtitle: string; onRefresh?: () => void }) {
  return (
    <Group justify="space-between" align="end" className="pageHeader">
      <div>
        <Title>{title}</Title>
        <Text c="dimmed">{subtitle}</Text>
      </div>
      {onRefresh ? <Button variant="light" onClick={onRefresh}>Refresh</Button> : null}
    </Group>
  );
}

export function EmptyState({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) {
  return (
    <Card withBorder className={compact ? 'emptyState compact' : 'emptyState'}>
      <Stack gap={4}>
        <Text fw={900}>{title}</Text>
        <Text c="dimmed" size="sm">{description}</Text>
      </Stack>
    </Card>
  );
}

export function LoadSettingsSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="loadSettingsSection">
      <button type="button" className="loadSettingsSectionHeader" onClick={onToggle}>
        <Text className="loadSettingsSectionTitle">{title}</Text>
        <span className={open ? 'sectionChevron open' : 'sectionChevron'}>⌄</span>
      </button>
      {open ? <Stack gap="md" className="loadSettingsSectionBody">{children}</Stack> : null}
    </div>
  );
}

function noticeTone(message: string): 'success' | 'error' | 'info' {
  const lower = message.toLowerCase();
  if (/(deleted|downloaded|imported|saved|created|updated|loaded|ejected|started|stopped|copied)/.test(lower)) return 'success';
  if (/(error|failed|unable|invalid|refusing|denied|required|missing|unknown|not found|must|only|conflict|already in use)/.test(lower)) return 'error';
  return 'info';
}

export function StatusCard({ message }: { message: string }) {
  return <Card withBorder className={`noticeCard ${noticeTone(message)}`}><Text>{message}</Text></Card>;
}

export function ErrorCard({ message }: { message: string }) {
  return <Card withBorder className="noticeCard error"><Text>{message}</Text></Card>;
}
