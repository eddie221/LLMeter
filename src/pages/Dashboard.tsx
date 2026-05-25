import { invoke } from '@tauri-apps/api/core';
import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import React, { useEffect, useMemo, useState } from 'react';

import type {
  DashboardScope,
  DashboardSummary,
  ModelDailyUsagePoint,
  SettingsRecord,
  TimeRange,
  TokenUsagePoint,
  UserAccount,
} from '../types';
import { modelChartColors } from '../constants';
import { Header, ErrorCard } from '../components/common';
import { InferenceParamsPanel } from '../components/InferenceParams';
import { useAsyncData } from '../hooks/useAsyncData';
import {
  addLocalDays,
  csvRow,
  dateKey,
  downloadTextFile,
  fillDailyUsageRange,
  formatCompact,
  getTimeWindow,
  rangeLabel,
  shortDate,
  startOfLocalDay,
} from '../lib/format';
import type { InferenceParams } from '../types';

export function MetricSparkline({ values, tone }: { values: number[]; tone: string }) {
  const width = 260;
  const height = 58;
  const pad = 10;
  const safeValues = values.length > 0 ? values : [0];
  const maxValue = Math.max(1, ...safeValues);
  const xFor = (index: number) => pad + (safeValues.length <= 1 ? width - pad * 2 : (index / (safeValues.length - 1)) * (width - pad * 2));
  const yFor = (value: number) => height - pad - (value / maxValue) * (height - pad * 2);
  const path = safeValues.length === 1
    ? `M ${pad} ${yFor(safeValues[0])} L ${width - pad} ${yFor(safeValues[0])}`
    : safeValues.map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(value)}`).join(' ');
  const lastX = xFor(safeValues.length - 1);
  const lastY = yFor(safeValues[safeValues.length - 1]);
  return <svg className="metricSparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><path d={path} className={`metricSparklinePath spark-${tone}`} /><circle cx={lastX} cy={lastY} r="5" className={`metricSparklinePoint spark-${tone}`} /></svg>;
}

export function DateRangePicker({ start, end, onApply, onPreset }: { start: string; end: string; onApply: (start: string, end: string) => void; onPreset: (start: string, end: string) => void }) {
  const today = startOfLocalDay(new Date());
  const initialBase = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const [baseMonth, setBaseMonth] = useState(initialBase);
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);
  const applyPreset = (kind: 'week' | 'month' | '7d' | '14d' | '30d') => {
    let from = today;
    if (kind === 'week') from = addLocalDays(today, -today.getDay());
    if (kind === 'month') from = new Date(today.getFullYear(), today.getMonth(), 1);
    if (kind === '7d') from = addLocalDays(today, -6);
    if (kind === '14d') from = addLocalDays(today, -13);
    if (kind === '30d') from = addLocalDays(today, -29);
    onPreset(dateKey(from), dateKey(today));
  };
  const chooseDay = (day: string) => {
    if (!draftStart || (draftStart && draftEnd) || day < draftStart) {
      setDraftStart(day);
      setDraftEnd('');
      return;
    }
    setDraftEnd(day);
  };
  const renderMonth = (month: Date) => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const totalDays = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const blanks = Array.from({ length: first.getDay() });
    const days = Array.from({ length: totalDays }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index + 1));
    return (
      <div className="rangeCalendarMonth">
        <Text className="rangeCalendarTitle">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        <div className="rangeCalendarWeekdays">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => <span key={day}>{day}</span>)}</div>
        <div className="rangeCalendarGrid">
          {blanks.map((_, index) => <span key={`blank-${index}`} />)}
          {days.map(day => {
            const key = dateKey(day);
            const isStart = key === draftStart;
            const isEnd = key === draftEnd;
            const inRange = Boolean(draftStart && draftEnd && key > draftStart && key < draftEnd);
            const isFuture = day > today;
            return <button key={key} type="button" className={isStart || isEnd ? 'selected' : inRange ? 'inRange' : ''} disabled={isFuture} onClick={() => chooseDay(key)}>{day.getDate()}</button>;
          })}
        </div>
      </div>
    );
  };
  return (
    <div className="rangePickerShell">
      <div className="rangePresetList">
        <button type="button" onClick={() => applyPreset('week')}>Week to date</button>
        <button type="button" onClick={() => applyPreset('month')}>Month to date</button>
        <button type="button" onClick={() => applyPreset('7d')}>Last 7 days</button>
        <button type="button" onClick={() => applyPreset('14d')}>Last 14 days</button>
        <button type="button" onClick={() => applyPreset('30d')}>Last 30 days</button>
      </div>
      <div className="rangeCalendarPane">
        <button type="button" className="rangeNavButton" onClick={() => setBaseMonth(new Date(baseMonth.getFullYear(), baseMonth.getMonth() - 1, 1))}>‹</button>
        <div className="rangeCalendarMonths">{renderMonth(baseMonth)}{renderMonth(new Date(baseMonth.getFullYear(), baseMonth.getMonth() + 1, 1))}</div>
        <button type="button" className="rangeNavButton" onClick={() => setBaseMonth(new Date(baseMonth.getFullYear(), baseMonth.getMonth() + 1, 1))}>›</button>
        <div className="rangePickerActions">
          <Text size="sm" c="dimmed">{draftStart || 'Start'} → {draftEnd || 'End'}</Text>
          <Button size="sm" onClick={() => onApply(draftStart, draftEnd || draftStart)} disabled={!draftStart}>Apply</Button>
        </div>
      </div>
    </div>
  );
}

export function ModelDailyTokenChart({ points, days, hiddenModels, onToggleModel }: { points: ModelDailyUsagePoint[]; days: string[]; hiddenModels: string[]; onToggleModel: (model: string) => void }) {
  const [hoveredDay, setHoveredDay] = useState<{ x: number; y: number; day: string } | null>(null);
  const width = 760;
  const height = 350;
  const padding = { top: 24, right: 20, bottom: 70, left: 58 };
  const models = Array.from(new Set(points.map(point => point.model)));
  const visibleModels = models.filter(model => !hiddenModels.includes(model));
  const totalsByDay = new Map<string, number>();
  for (const point of points) {
    if (!hiddenModels.includes(point.model)) {
      totalsByDay.set(point.day, (totalsByDay.get(point.day) ?? 0) + point.total_tokens);
    }
  }
  const maxValue = Math.max(1, ...Array.from(totalsByDay.values()));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const groupWidth = days.length > 0 ? plotWidth / days.length : plotWidth;
  const barWidth = Math.max(8, Math.min(28, groupWidth * 0.58));
  const yFor = (value: number) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const colorFor = (model: string) => modelChartColors[Math.max(0, models.indexOf(model)) % modelChartColors.length];
  const valueFor = (day: string, model: string) => points.find(point => point.day === day && point.model === model)?.total_tokens ?? 0;
  const hoveredRows = hoveredDay ? visibleModels.map(model => ({ model, tokens: valueFor(hoveredDay.day, model), color: colorFor(model) })).filter(row => row.tokens > 0) : [];

  if (days.length === 0) {
    return <div className="lineChartEmpty"><Text c="dimmed">No token usage logged yet.</Text></div>;
  }

  return (
    <div className="modelTokenChartWrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily token usage by model" className="modelTokenChart">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + plotHeight - ratio * plotHeight;
          return <g key={ratio}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chartGrid" /><text x={padding.left - 10} y={y + 4} textAnchor="end" className="chartAxisText">{formatCompact(Math.round(maxValue * ratio))}</text></g>;
        })}
        {days.map((day, dayIndex) => {
          let stacked = 0;
          const x = padding.left + dayIndex * groupWidth + (groupWidth - barWidth) / 2;
          return <g key={day}>{visibleModels.map((model) => {
            const value = valueFor(day, model);
            if (value <= 0) return null;
            const yTop = yFor(stacked + value);
            const yBottom = yFor(stacked);
            stacked += value;
            return <rect key={`${day}-${model}`} x={x} y={yTop} width={barWidth} height={Math.max(2, yBottom - yTop)} rx="4" fill={colorFor(model)} opacity="0.88" onMouseEnter={() => setHoveredDay({ x: x + barWidth / 2, y: yTop, day })} onMouseMove={() => setHoveredDay({ x: x + barWidth / 2, y: yTop, day })} onMouseLeave={() => setHoveredDay(null)} />;
          })}{stacked <= 0 ? <rect key={`${day}-zero`} x={x} y={yFor(0) - 3} width={barWidth} height={3} rx="2" className="zeroUsageBar" onMouseEnter={() => setHoveredDay({ x: x + barWidth / 2, y: yFor(0) - 3, day })} onMouseMove={() => setHoveredDay({ x: x + barWidth / 2, y: yFor(0) - 3, day })} onMouseLeave={() => setHoveredDay(null)} /> : null}<text x={x + barWidth / 2} y={height - 36} textAnchor="middle" className="chartAxisText">{shortDate(day)}</text></g>;
        })}
        <text x={padding.left + plotWidth / 2} y={height - 10} textAnchor="middle" className="chartAxisTitle">Date</text>
        {hoveredDay ? <g className="chartTooltip chartTooltipList" transform={`translate(${Math.min(width - 330, Math.max(220, hoveredDay.x))} ${Math.max(92, hoveredDay.y - 96)})`}><rect x="-210" y="-72" width="420" height={Math.max(100, 56 + hoveredRows.length * 26)} rx="14" /><text x="-188" y="-46" textAnchor="start" className="chartTooltipTitle">{hoveredDay.day}</text><line x1="-188" x2="188" y1="-28" y2="-28" className="chartTooltipDivider" />{hoveredRows.map((row, index) => <g key={row.model} transform={`translate(0 ${index * 26})`}><rect x="-188" y="-14" width="10" height="10" rx="3" fill={row.color} /><text x="-170" y="-5" textAnchor="start" className="chartTooltipText" fill={row.color}>{row.model}</text><text x="188" y="-5" textAnchor="end" className="chartTooltipValue">{row.tokens.toLocaleString()}</text></g>)}</g> : null}
      </svg>
      <Group gap="md" className="chartLegend modelLegend">{models.slice(0, 10).map(model => <button key={model} type="button" className={hiddenModels.includes(model) ? 'modelLegendButton inactive' : 'modelLegendButton'} onClick={() => onToggleModel(model)}><span className="legendDot" style={{ background: colorFor(model) }} />{model}</button>)}</Group>
    </div>
  );
}

export function TokenUsageLineChart({ points }: { points: TokenUsagePoint[] }) {
  const width = 760;
  const height = 260;
  const padding = { top: 24, right: 28, bottom: 38, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...points.map((point) => point.total_tokens));
  const xFor = (index: number) => padding.left + (points.length <= 1 ? plotWidth : (index / (points.length - 1)) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - (value / maxValue) * plotHeight;
  const pathFor = (key: 'input_tokens' | 'output_tokens' | 'total_tokens') => {
    if (points.length === 0) return '';
    if (points.length === 1) {
      const x1 = padding.left;
      const x2 = padding.left + plotWidth;
      const y = yFor(points[0][key]);
      return `M ${x1} ${y} L ${x2} ${y}`;
    }
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point[key])}`).join(' ');
  };
  const lastPoint = points[points.length - 1];

  if (points.length === 0) {
    return <div className="lineChartEmpty"><Text c="dimmed">No token usage logged yet.</Text></div>;
  }

  return (
    <div className="lineChartWrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily token usage line chart" className="lineChart">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + plotHeight - ratio * plotHeight;
          const value = Math.round(maxValue * ratio);
          return <g key={ratio}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chartGrid" /><text x={padding.left - 10} y={y + 4} textAnchor="end" className="chartAxisText">{formatCompact(value)}</text></g>;
        })}
        <path d={pathFor('total_tokens')} className="chartLine chartLineTotal" />
        <path d={pathFor('input_tokens')} className="chartLine chartLineInput" />
        <path d={pathFor('output_tokens')} className="chartLine chartLineOutput" />
        {points.map((point, index) => <circle key={`${point.day}-total`} cx={xFor(index)} cy={yFor(point.total_tokens)} r={index === points.length - 1 ? 5 : 3} className="chartPointTotal" />)}
        {lastPoint ? <text x={width - padding.right} y={height - 12} textAnchor="end" className="chartAxisText">{lastPoint.day}</text> : null}
        <text x={padding.left} y={height - 12} textAnchor="start" className="chartAxisText">{points[0].day}</text>
      </svg>
    </div>
  );
}

export function InferenceDefaultsCard({ currentUser, embedded = false }: { currentUser: UserAccount; embedded?: boolean }) {
  const settings = useAsyncData<SettingsRecord>(
    () => invoke('get_settings', { requesterRole: currentUser.role }),
    [currentUser.role],
  );
  const [params, setParams] = useState<InferenceParams>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data?.inference_defaults) setParams(settings.data.inference_defaults);
  }, [settings.data?.inference_defaults]);

  const save = async () => {
    if (!settings.data) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const updated = await invoke<SettingsRecord>('save_settings', {
        input: { ...settings.data, inference_defaults: Object.keys(params).length > 0 ? params : null },
        requesterRole: currentUser.role,
      });
      settings.setData(updated);
      setSaveMsg('Saved.');
    } catch (err) {
      setSaveMsg(String(err));
    } finally {
      setSaving(false);
    }
  };

  const inner = (
    <Stack gap="md">
      <div className="loadSettingsIntro">
        <Text fw={700} size="sm">Inference Defaults</Text>
        <Text size="xs" c="dimmed">Default hyperparameters applied to every chat request. Override per-session from the Chat tab sidebar.</Text>
      </div>
      <InferenceParamsPanel params={params} onChange={setParams} title="Default Parameters" compact />
      <div style={{ padding: '0 16px 16px' }}>
        <Button size="xs" onClick={save} loading={saving} disabled={!settings.data}>Save defaults</Button>
        {saveMsg ? <Text size="xs" c={saveMsg === 'Saved.' ? 'teal' : 'red'} mt={4}>{saveMsg}</Text> : null}
      </div>
    </Stack>
  );

  if (embedded) return inner;
  return (
    <Card withBorder p={0} className="loadSettingsCard">
      {inner}
    </Card>
  );
}

export function Metric({ label, value, tone = 'blue', values = [] }: { label: string; value: number; tone?: string; values?: number[] }) {
  return <Card withBorder className={`metricCard metric-${tone}`}><Text c="dimmed" size="sm">{label}</Text><Title>{value.toLocaleString()}</Title><MetricSparkline values={values} tone={tone} /></Card>;
}

export function DashboardPage({ currentUser }: { currentUser: UserAccount }) {
  const [scope, setScope] = useState<DashboardScope>(currentUser.role === 'admin' ? 'all' : 'mine');
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [hiddenChartModels, setHiddenChartModels] = useState<string[]>([]);
  const { startTs, endTs } = getTimeWindow(timeRange, customStart, customEnd);
  const { data, error, reload } = useAsyncData<DashboardSummary>(
    () => invoke('dashboard', {
      requesterUserId: currentUser.id,
      requesterRole: currentUser.role,
      scope,
      startTs,
      endTs,
    }),
    [currentUser.id, currentUser.role, scope, startTs, endTs],
  );
  const displayDailyUsage = useMemo(
    () => fillDailyUsageRange(data?.daily_usage ?? [], startTs, endTs),
    [data?.daily_usage, startTs, endTs],
  );
  const displayDays = useMemo(() => displayDailyUsage.map(point => point.day), [displayDailyUsage]);
  const selectRange = (range: TimeRange) => {
    if (range === 'custom') {
      setCustomOpen(true);
    }
    setTimeRange(range);
  };
  const toggleChartModel = (model: string) => {
    setHiddenChartModels((hidden) => hidden.includes(model) ? hidden.filter(item => item !== model) : [...hidden, model]);
  };
  const downloadShownCsv = () => {
    if (!data) return;
    const totalTokens = (data.input_tokens ?? 0) + (data.output_tokens ?? 0);
    const csv = [
      ['Summary'],
      ['Scope', scope],
      ['Range', rangeLabel(timeRange, customStart, customEnd)],
      ['Total requests', data.request_count],
      ['Input tokens', data.input_tokens],
      ['Output tokens', data.output_tokens],
      ['Total tokens', totalTokens],
      [],
      ['Daily usage'],
      ['Date', 'Requests', 'Input tokens', 'Output tokens', 'Total tokens'],
      ...displayDailyUsage.map(point => [point.day, point.requests, point.input_tokens, point.output_tokens, point.total_tokens]),
      [],
      ['Model breakdown'],
      ['Model', 'Provider', 'Requests', 'Input tokens', 'Output tokens', 'Total tokens'],
      ...(data.model_usage ?? []).map(item => [item.model, 'Local', item.requests, item.input_tokens, item.output_tokens, item.input_tokens + item.output_tokens]),
    ].map(csvRow).join('\n');
    downloadTextFile(`llmeter-overview-${dateKey(new Date())}.csv`, csv, 'text/csv;charset=utf-8');
  };
  return <Stack>
    <Header title="Overview" subtitle="Request and token usage at a glance." onRefresh={reload} />
    {error ? <ErrorCard message={error} /> : null}
    <Group className="filterRail">
      {currentUser.role === 'admin' ? <Button size="sm" className={scope === 'all' ? 'filterChip active' : 'filterChip'} onClick={() => setScope('all')}>All users</Button> : null}
      <Button size="sm" className={scope === 'mine' ? 'filterChip active' : 'filterChip'} onClick={() => setScope('mine')}>Mine</Button>
      <span className="railDivider" />
      <Button size="sm" className={timeRange === 'all' ? 'filterChip active' : 'filterChip'} onClick={() => selectRange('all')}>All time</Button>
      <Button size="sm" className={timeRange === 'today' ? 'filterChip active' : 'filterChip'} onClick={() => selectRange('today')}>Today</Button>
      <Button size="sm" className={timeRange === '7d' ? 'filterChip active' : 'filterChip'} onClick={() => selectRange('7d')}>7 days</Button>
      <Button size="sm" className={timeRange === '30d' ? 'filterChip active' : 'filterChip'} onClick={() => selectRange('30d')}>30 days</Button>
      <Button size="sm" className={timeRange === 'custom' ? 'filterChip active' : 'filterChip'} onClick={() => selectRange('custom')}>Custom...</Button>
      <Button size="sm" className="filterChip" onClick={downloadShownCsv} disabled={!data}>Download CSV</Button>
    </Group>
    <Modal opened={customOpen} onClose={() => setCustomOpen(false)} title="Select date range" centered size="auto">
      <DateRangePicker
        start={customStart}
        end={customEnd}
        onApply={(start, end) => {
          setCustomStart(start);
          setCustomEnd(end);
          setTimeRange('custom');
          setCustomOpen(false);
        }}
        onPreset={(start, end) => {
          setCustomStart(start);
          setCustomEnd(end);
          setTimeRange('custom');
          setCustomOpen(false);
        }}
      />
    </Modal>
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}><Metric label="Total requests" value={data?.request_count ?? 0} tone="blue" values={displayDailyUsage.map(point => point.requests)} /><Metric label="Input tokens" value={data?.input_tokens ?? 0} tone="green" values={displayDailyUsage.map(point => point.input_tokens)} /><Metric label="Output tokens" value={data?.output_tokens ?? 0} tone="purple" values={displayDailyUsage.map(point => point.output_tokens)} /><Metric label="Total tokens" value={(data?.input_tokens ?? 0) + (data?.output_tokens ?? 0)} tone="orange" values={displayDailyUsage.map(point => point.total_tokens)} /></SimpleGrid>
    <SimpleGrid cols={1}>
      <Card withBorder className="dailyUsagePanel"><Group justify="space-between" align="center" className="dailyUsageHeader"><Title order={3}>Usage</Title><Group gap="sm"><span className="usagePill usageStaticPill">Default project ×</span><Button className="usagePill usageDatePill" variant="default" onClick={() => selectRange('custom')}>{rangeLabel(timeRange, customStart, customEnd)}</Button><Button className="usageIconButton" variant="default" onClick={() => void reload()}>Refresh</Button></Group></Group><Group className="usageRangeRail dailyUsageRangeRail"><Button size="sm" className={timeRange === 'today' ? 'usageRangeChip active' : 'usageRangeChip'} onClick={() => selectRange('today')}>Today</Button><Button size="sm" className={timeRange === '7d' ? 'usageRangeChip active' : 'usageRangeChip'} onClick={() => selectRange('7d')}>Last 7 days</Button><Button size="sm" className={timeRange === '30d' ? 'usageRangeChip active' : 'usageRangeChip'} onClick={() => selectRange('30d')}>Last 30 days</Button><Button size="sm" className={timeRange === 'custom' ? 'usageRangeChip active' : 'usageRangeChip'} onClick={() => selectRange('custom')}>Custom</Button></Group><ModelDailyTokenChart points={data?.model_daily_usage ?? []} days={displayDays} hiddenModels={hiddenChartModels} onToggleModel={toggleChartModel} /></Card>
      <Card withBorder><Title order={3}>Model breakdown</Title><Table.ScrollContainer minWidth={760}><Table mt="md"><Table.Thead><Table.Tr><Table.Th>Model</Table.Th><Table.Th>Provider</Table.Th><Table.Th>Requests</Table.Th><Table.Th>Input</Table.Th><Table.Th>Output</Table.Th><Table.Th>Total</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{(data?.model_usage ?? []).map((item) => <Table.Tr key={item.model}><Table.Td>{item.model}</Table.Td><Table.Td><Badge color="green" variant="light">Local</Badge></Table.Td><Table.Td>{item.requests.toLocaleString()}</Table.Td><Table.Td>{item.input_tokens.toLocaleString()}</Table.Td><Table.Td>{item.output_tokens.toLocaleString()}</Table.Td><Table.Td>{(item.input_tokens + item.output_tokens).toLocaleString()}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer></Card>
    </SimpleGrid>
  </Stack>;
}
