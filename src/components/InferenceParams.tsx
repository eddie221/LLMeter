import { Badge, Checkbox, Group, NumberInput, Slider, Stack, Text, TextInput } from '@mantine/core';
import React, { useState } from 'react';

import type { InferenceParams } from '../types';

export function exportInferenceParams(params: InferenceParams) {
  const json = JSON.stringify(params, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'inference-params.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function importInferenceParams(file: File, onLoad: (params: InferenceParams) => void, onError: (msg: string) => void) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target?.result as string ?? '{}') as InferenceParams;
      onLoad(parsed);
    } catch {
      onError('Invalid JSON file.');
    }
  };
  reader.readAsText(file);
}

export function InferenceParamsPanel({
  params,
  onChange,
  title = 'Inference Params',
  compact = false,
}: {
  params: InferenceParams;
  onChange: (p: InferenceParams) => void;
  title?: string;
  compact?: boolean;
}) {
  const [stopInput, setStopInput] = useState('');
  const importRef = React.useRef<HTMLInputElement>(null);
  const set = (patch: Partial<InferenceParams>) => onChange({ ...params, ...patch });
  const hasTemp = params.temperature !== undefined;
  const hasMaxTokens = params.max_tokens !== undefined;
  const hasTopP = params.top_p !== undefined;
  const hasTopK = params.top_k !== undefined;
  const hasMinP = params.min_p !== undefined;
  const hasRepeatPenalty = params.repeat_penalty !== undefined;
  const hasPresencePenalty = params.presence_penalty !== undefined;
  return (
    <div className={compact ? 'inferParamsPanel compact' : 'inferParamsPanel'}>
      <div className="inferParamsHeader">
        <Text fw={700} size="sm">{title}</Text>
        <Group gap={6}>
          <button type="button" className="inferParamsBtn" title="Import from JSON" onClick={() => importRef.current?.click()}>↑ Import</button>
          <button type="button" className="inferParamsBtn" title="Export to JSON" onClick={() => exportInferenceParams(params)}>↓ Export</button>
          <button type="button" className="inferParamsBtn inferParamsBtnReset" title="Reset all to model defaults" onClick={() => onChange({})}>Reset</button>
        </Group>
      </div>
      <input ref={importRef} type="file" accept=".json" hidden onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        if (file) importInferenceParams(file, onChange, () => {});
        e.currentTarget.value = '';
      }} />
      <Stack gap={8} className="inferParamsBody">
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Temperature</Text>
            <Checkbox size="xs" checked={hasTemp} onChange={(e) => set({ temperature: e.currentTarget.checked ? 0.8 : undefined })} label={hasTemp ? String((params.temperature ?? 0.8).toFixed(2)) : 'default'} />
          </Group>
          {hasTemp && <Slider min={0} max={2} step={0.01} value={params.temperature ?? 0.8} onChange={(v) => set({ temperature: v })} />}
        </div>
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Max Tokens</Text>
            <Checkbox size="xs" checked={hasMaxTokens} onChange={(e) => set({ max_tokens: e.currentTarget.checked ? 2048 : undefined })} label={hasMaxTokens ? String(params.max_tokens) : 'default'} />
          </Group>
          {hasMaxTokens && <NumberInput size="xs" min={1} max={131072} value={params.max_tokens ?? 2048} onChange={(v) => set({ max_tokens: Number(v) || 2048 })} />}
        </div>
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Top P</Text>
            <Checkbox size="xs" checked={hasTopP} onChange={(e) => set({ top_p: e.currentTarget.checked ? 0.95 : undefined })} label={hasTopP ? String((params.top_p ?? 0.95).toFixed(2)) : 'default'} />
          </Group>
          {hasTopP && <Slider min={0} max={1} step={0.01} value={params.top_p ?? 0.95} onChange={(v) => set({ top_p: v })} />}
        </div>
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Top K</Text>
            <Checkbox size="xs" checked={hasTopK} onChange={(e) => set({ top_k: e.currentTarget.checked ? 40 : undefined })} label={hasTopK ? String(params.top_k) : 'default'} />
          </Group>
          {hasTopK && <NumberInput size="xs" min={1} max={1000} value={params.top_k ?? 40} onChange={(v) => set({ top_k: Number(v) || 40 })} />}
        </div>
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Min P</Text>
            <Checkbox size="xs" checked={hasMinP} onChange={(e) => set({ min_p: e.currentTarget.checked ? 0.05 : undefined })} label={hasMinP ? String((params.min_p ?? 0.05).toFixed(2)) : 'default'} />
          </Group>
          {hasMinP && <Slider min={0} max={1} step={0.01} value={params.min_p ?? 0.05} onChange={(v) => set({ min_p: v })} />}
        </div>
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Repeat Penalty</Text>
            <Checkbox size="xs" checked={hasRepeatPenalty} onChange={(e) => set({ repeat_penalty: e.currentTarget.checked ? 1.1 : undefined })} label={hasRepeatPenalty ? String((params.repeat_penalty ?? 1.1).toFixed(2)) : 'default'} />
          </Group>
          {hasRepeatPenalty && <Slider min={1} max={2} step={0.01} value={params.repeat_penalty ?? 1.1} onChange={(v) => set({ repeat_penalty: v })} />}
        </div>
        <div className="inferParamRow">
          <Group justify="space-between" gap={4}>
            <Text size="xs" c="dimmed">Presence Penalty</Text>
            <Checkbox size="xs" checked={hasPresencePenalty} onChange={(e) => set({ presence_penalty: e.currentTarget.checked ? 0 : undefined })} label={hasPresencePenalty ? String((params.presence_penalty ?? 0).toFixed(2)) : 'default'} />
          </Group>
          {hasPresencePenalty && <Slider min={-2} max={2} step={0.01} value={params.presence_penalty ?? 0} onChange={(v) => set({ presence_penalty: v })} />}
        </div>
        <div className="inferParamRow">
          <Text size="xs" c="dimmed">Stop Strings</Text>
          <TextInput
            size="xs"
            placeholder="Add stop string, press Enter"
            value={stopInput}
            onChange={(e) => setStopInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const v = stopInput.trim();
                if (v && !(params.stop ?? []).includes(v)) {
                  set({ stop: [...(params.stop ?? []), v] });
                }
                setStopInput('');
              }
            }}
          />
          {(params.stop ?? []).length > 0 && (
            <Group gap={4} mt={4}>
              {(params.stop ?? []).map(s => (
                <Badge key={s} size="xs" variant="light" color="gray" style={{ cursor: 'pointer' }} onClick={() => set({ stop: (params.stop ?? []).filter(x => x !== s) })}>
                  {s} ×
                </Badge>
              ))}
            </Group>
          )}
        </div>
      </Stack>
    </div>
  );
}
