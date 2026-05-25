import type { ModelLoadSettings, Page } from './types';

export const pageLabels: Array<[Page, string]> = [
  ['dashboard', 'Dashboard'],
  ['chat', 'Chat'],
  ['models', 'Server'],
  ['logs', 'Logs'],
  ['admin', 'Admin'],
  ['profile', 'Profile'],
  ['settings', 'Settings'],
];

export const ANTHROPIC_MODELS = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

export const shownNumberOptions = ['10', '25', '50', '100'];

export const passwordPolicyText = 'At least 12 characters with uppercase, lowercase, number, and symbol.';

export const defaultModelLoadSettings: ModelLoadSettings = {
  temperature: 0.8,
  limit_response_length: false,
  max_tokens: 2048,
  context_overflow: 'truncate_middle',
  stop_strings: [],
  top_k: 40,
  repeat_penalty_enabled: true,
  repeat_penalty: 1.1,
  presence_penalty_enabled: false,
  presence_penalty: 0,
  top_p_enabled: true,
  top_p: 0.95,
  min_p_enabled: true,
  min_p: 0.05,
};

export const modelChartColors = ['#14b8a6', '#4285f4', '#f2418f', '#9b5cf6', '#ff8a33', '#61c46d', '#facc15', '#38bdf8', '#fb7185', '#a3e635'];

export const MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
