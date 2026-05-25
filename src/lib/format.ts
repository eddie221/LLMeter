import type { TimeRange, TokenUsagePoint } from '../types';

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

export function formatCompact(value: number) {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function shortDate(day: string) {
  const parts = day.split('-');
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day;
}

export function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]) {
  return values.map(csvCell).join(',');
}

export function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function parseDayKey(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(date)
    ? new Date(year, month - 1, date)
    : null;
}

export function formatHeroDate(day: string) {
  const parsed = parseDayKey(day);
  return parsed ? parsed.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) : day;
}

export function rangeLabel(range: TimeRange, customStart: string, customEnd: string) {
  if (range === 'today') return 'Today';
  if (range === '7d') return 'Last 7 days';
  if (range === '30d') return 'Last 30 days';
  if (range === 'custom') {
    if (customStart && customEnd) return `${customStart} to ${customEnd}`;
    if (customStart) return `From ${customStart}`;
    if (customEnd) return `Until ${customEnd}`;
    return 'Custom range';
  }
  return 'All time';
}

export function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function dashboardDateRange(startTs: number | null, endTs: number | null, existingDays: string[]) {
  const sortedExisting = Array.from(new Set(existingDays)).sort();
  if (startTs === null && endTs === null) return sortedExisting;
  const now = new Date();
  const firstExisting = sortedExisting[0] ? parseDayKey(sortedExisting[0]) : null;
  const end = endTs !== null ? new Date(endTs * 1000) : now;
  const start = startTs !== null ? new Date(startTs * 1000) : (firstExisting ?? end);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const days: string[] = [];
  while (cursor <= last) {
    days.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function fillDailyUsageRange(points: TokenUsagePoint[], startTs: number | null, endTs: number | null) {
  const byDay = new Map(points.map(point => [point.day, point]));
  return dashboardDateRange(startTs, endTs, points.map(point => point.day)).map(day => byDay.get(day) ?? {
    day,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  });
}

export function getTimeWindow(range: TimeRange, customStart: string, customEnd: string) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);
  if (range === 'today') return { startTs: toSeconds(todayStart), endTs: null };
  if (range === '7d') {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - 6);
    return { startTs: toSeconds(start), endTs: null };
  }
  if (range === '30d') {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - 29);
    return { startTs: toSeconds(start), endTs: null };
  }
  if (range === 'custom') {
    const startTs = customStart ? toSeconds(new Date(`${customStart}T00:00:00`)) : null;
    const endTs = customEnd ? toSeconds(new Date(`${customEnd}T23:59:59`)) : null;
    return { startTs, endTs };
  }
  return { startTs: null, endTs: null };
}
