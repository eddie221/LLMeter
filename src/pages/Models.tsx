import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  Menu,
  Modal,
  Notification,
  NumberInput,
  Progress,
  Select,
  Slider,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DownloadProgressPayload,
  HfFormatFilter,
  HuggingFaceFile,
  HuggingFaceModel,
  HuggingFaceRepoFileRequest,
  LoadedModelStatus,
  ModelLoadSettings,
  ModelRecord,
  Page,
  ServerStatus,
  SystemMemory,
  UserAccount,
} from '../types';
import { defaultModelLoadSettings } from '../constants';
import { Bi } from '../components/Bi';
import { EmptyState, ErrorCard, Header, LoadSettingsSection, StatusCard, TableControls } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';
import { paginateRows } from '../lib/pagination';
import { formatBytes } from '../lib/format';
import { SettingsPanel } from './Settings';
import { renderLogLine } from './Logs';

export type HfDownloadOption = { key: string; label: string; size: number | null; files: Array<{ name: string; size: number | null }> };

export type DownloadStatus = 'downloading' | 'done' | 'error' | 'cancelled';
export type DownloadEntry = {
  id: string;
  label: string;
  sizeBytes: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  status: DownloadStatus;
  startedAt: number;
  partIndex: number;
  partTotal: number;
};

export type Compat = 'fits' | 'tight' | 'too_large' | 'unknown';

// Overhead estimate: 512 MB for KV-cache, buffers, and runtime
const RAM_OVERHEAD_BYTES = 512 * 1024 * 1024;

export function getCompatibility(sizeBytes: number | null, mem: SystemMemory | null): Compat {
  if (!sizeBytes || !mem || mem.total_bytes === 0) return 'unknown';
  const needed = sizeBytes + RAM_OVERHEAD_BYTES;
  if (needed < mem.total_bytes * 0.50) return 'fits';
  if (needed < mem.total_bytes * 0.75) return 'tight';
  return 'too_large';
}

export function CompatIcon({ compat, size: bytes }: { compat: Compat; size: number | null }) {
  const labels: Record<Compat, string> = {
    fits: 'Fits in available RAM',
    tight: 'May fit — RAM is tight',
    too_large: 'Exceeds available RAM',
    unknown: 'RAM usage unknown',
  };
  const icons: Record<Compat, string> = {
    fits: 'check-circle-fill',
    tight: 'exclamation-triangle-fill',
    too_large: 'x-circle-fill',
    unknown: 'question-circle',
  };
  const colors: Record<Compat, string> = {
    fits: '#4ade80',
    tight: '#facc15',
    too_large: '#f87171',
    unknown: '#6b7280',
  };
  const _ = bytes; // referenced by tooltip if needed
  return (
    <span
      title={labels[compat]}
      style={{ color: colors[compat], fontSize: 14, lineHeight: 1, flexShrink: 0, cursor: 'default' }}
    >
      <i className={`bi bi-${icons[compat]}`} />
    </span>
  );
}

export function pipelineTagToDisplay(tag: string): { label: string; color: string } {
  switch (tag) {
    case 'image-text-to-text':
    case 'visual-question-answering':
    case 'image-to-text':
      return { label: 'vision · text+image', color: 'violet' };
    case 'automatic-speech-recognition':
    case 'audio-to-audio':
    case 'text-to-speech':
      return { label: 'audio', color: 'orange' };
    case 'feature-extraction':
    case 'sentence-similarity':
      return { label: 'embedding', color: 'cyan' };
    case 'text-ranking':
      return { label: 'reranker', color: 'pink' };
    case 'text-generation':
    case 'text2text-generation':
    case 'conversational':
    default:
      return { label: 'llm · text', color: 'blue' };
  }
}

export function ModelTypeBadge({ model }: { model: ModelRecord }) {
  if (!model.hf_repo) return null;
  if (!model.model_type) return <Badge color="gray" variant="outline" title="Type unknown — use Refresh to fetch from HuggingFace">type unknown</Badge>;
  const { label, color } = pipelineTagToDisplay(model.model_type);
  return <Badge color={color} variant="light">{label}</Badge>;
}

export function hfCapabilities(model: HuggingFaceModel): string[] {
  const tags = (model.tags ?? []).map(t => t.toLowerCase());
  const pipeline = (model.pipeline_tag ?? '').toLowerCase();
  const id = ((model.id ?? model.modelId ?? '')).toLowerCase();
  const caps: string[] = [];
  if (pipeline.includes('image') || tags.some(t => ['vision', 'multimodal', 'image-text-to-text', 'visual-question-answering'].includes(t)))
    caps.push('vision');
  if (tags.some(t => ['tool-use', 'function-calling', 'tools', 'tool_use', 'function_calling'].includes(t)))
    caps.push('tool-use');
  if (tags.includes('reasoning') || /qwq|deepseek-r|\.think|reason/.test(id))
    caps.push('reasoning');
  return caps;
}

export function huggingFaceModelId(model: HuggingFaceModel) { return model.id ?? model.modelId ?? 'unknown'; }
export function huggingFaceRepoPath(modelId: string) { return modelId.split('/').map(segment => encodeURIComponent(segment)).join('/'); }
export function huggingFaceApiModelUrl(modelId: string) { return `https://huggingface.co/api/models/${huggingFaceRepoPath(modelId)}`; }
export function huggingFaceModelUrl(modelId: string) { return `https://huggingface.co/${huggingFaceRepoPath(modelId)}`; }
export function huggingFaceResolveUrl(modelId: string, fileName: string) { return `https://huggingface.co/${huggingFaceRepoPath(modelId)}/resolve/main/${fileName.split('/').map(segment => encodeURIComponent(segment)).join('/')}`; }
export function huggingFaceLicense(model: HuggingFaceModel) { return model.tags?.find(item => item.startsWith('license:'))?.replace('license:', '') ?? 'Unknown'; }
export function hfShortModelName(modelId: string) { return modelId.split('/').pop() ?? modelId; }
export function hfModelInitial(modelId: string) { return hfShortModelName(modelId).replace(/[^a-z0-9]/ig, '').slice(0, 1).toUpperCase() || 'M'; }
export function hfLastUpdated(model: HuggingFaceModel) {
  if (!model.lastModified) return 'Unknown';
  const diff = Math.max(0, Date.now() - new Date(model.lastModified).getTime());
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return 'today';
  if (diff < day * 30) return `${Math.floor(diff / day)} days ago`;
  return `${Math.floor(diff / (day * 30))} months ago`;
}
export function hfCardValue(model: HuggingFaceModel, key: string) {
  const value = model.cardData?.[key] ?? model.config?.[key];
  return Array.isArray(value) ? value.join(', ') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
export function hfModelSubtitle(model: HuggingFaceModel) {
  return hfCardValue(model, 'summary') || hfCardValue(model, 'description') || model.pipeline_tag || (model.tags ?? []).slice(0, 3).join(' · ') || 'Hugging Face GGUF model';
}
export function hfModelSummary(model: HuggingFaceModel) {
  return hfCardValue(model, 'summary') || hfCardValue(model, 'description') || `Metadata from Hugging Face indicates pipeline ${model.pipeline_tag ?? 'unknown'} with ${(model.tags ?? []).length} tags. Review the model card and license before commercial use.`;
}
export function hfMetadataPills(model: HuggingFaceModel) {
  const params = hfCardValue(model, 'params') || hfCardValue(model, 'parameters');
  const arch = hfCardValue(model, 'architecture') || hfCardValue(model, 'model_type');
  const domain = hfCardValue(model, 'domain') || model.pipeline_tag || 'model';
  return [
    params ? { label: 'Params', value: params, color: 'gray', strong: false } : null,
    arch ? { label: 'Arch', value: arch, color: 'gray', strong: false } : null,
    { label: 'Domain', value: domain, color: 'blue', strong: false },
    { label: 'Format', value: huggingFaceGgufFiles(model).length > 0 ? 'GGUF' : 'HF', color: 'blue', strong: true },
  ].filter((pill): pill is { label: string; value: string; color: string; strong: boolean } => Boolean(pill));
}

function hfDownloadLabel(fileName: string) {
  return fileName.split('/').pop()?.replace(/\.gguf$/i, '').replace(/[-_.]+/g, ' ') ?? fileName;
}

export function fileBaseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function huggingFaceGgufFiles(model: HuggingFaceModel) {
  const files = (model.siblings ?? [])
    .map(file => ({ name: file.rfilename ?? '', size: file.size ?? file.lfs?.size ?? null }))
    .filter(file => {
      const lower = file.name.toLowerCase();
      return lower.endsWith('.gguf') && !lower.endsWith('.part') && !lower.includes('.part.') && !lower.includes('mmproj');
    });
  const grouped = new Map<string, HfDownloadOption>();
  for (const file of files) {
    const baseName = file.name.split('/').pop() ?? file.name;
    const splitMatch = baseName.match(/^(.*?)(?:[-_. ]?)(\d{5})-of-(\d{5})\.gguf$/i);
    const key = splitMatch ? `${file.name.slice(0, file.name.length - baseName.length)}${splitMatch[1]}-split-${splitMatch[3]}` : file.name;
    const existing = grouped.get(key);
    if (existing) {
      existing.files.push(file);
      existing.size = existing.size === null || file.size === null ? null : existing.size + file.size;
    } else {
      grouped.set(key, {
        key,
        label: splitMatch ? hfDownloadLabel(`${splitMatch[1]}.gguf`) : hfDownloadLabel(file.name),
        size: file.size,
        files: [file],
      });
    }
  }
  return Array.from(grouped.values())
    .map(option => ({ ...option, files: option.files.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function huggingFaceConvertibleFiles(model: HuggingFaceModel): HuggingFaceRepoFileRequest[] {
  const allowed = ['.safetensors', '.json', '.model', '.txt', '.tiktoken', '.spm', '.vocab', '.merges'];
  return (model.siblings ?? [])
    .map(file => ({ name: file.rfilename ?? '', size: file.size ?? file.lfs?.size ?? null }))
    .filter(file => {
      const lower = file.name.toLowerCase();
      return allowed.some(suffix => lower.endsWith(suffix)) && !lower.includes('/.git') && !lower.endsWith('.gguf');
    })
    .sort((a, b) => {
      const aWeight = a.name.toLowerCase().endsWith('.safetensors') ? 0 : 1;
      const bWeight = b.name.toLowerCase().endsWith('.safetensors') ? 0 : 1;
      return aWeight - bWeight || a.name.localeCompare(b.name);
    });
}

export function huggingFaceTransformerFiles(model: HuggingFaceModel) {
  const transformerWeights = ['.safetensors', '.bin', '.h5', '.msgpack'];
  return (model.siblings ?? [])
    .map(file => file.rfilename ?? '')
    .filter(name => {
      const lower = name.toLowerCase();
      return transformerWeights.some(suffix => lower.endsWith(suffix))
        && !lower.endsWith('.gguf')
        && !lower.includes('/.git')
        && !lower.includes('.part.');
    });
}

export async function enrichHuggingFaceFileSizes(model: HuggingFaceModel): Promise<HuggingFaceModel> {
  const modelId = huggingFaceModelId(model);
  if (modelId === 'unknown') return model;
  const siblings = await Promise.all((model.siblings ?? []).map(async (file) => {
    const name = file.rfilename ?? '';
    if ((!name.toLowerCase().endsWith('.gguf') && !name.toLowerCase().endsWith('.safetensors')) || file.size || file.lfs?.size) return file;
    try {
      const response = await fetch(huggingFaceResolveUrl(modelId, name), { method: 'HEAD' });
      const size = Number(response.headers.get('content-length') ?? 0);
      return size > 0 ? { ...file, size } : file;
    } catch {
      return file;
    }
  }));
  return { ...model, siblings };
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between" gap="xs" style={{ padding: '3px 0' }}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="xs" fw={600} style={{ textAlign: 'right', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</Text>
    </Group>
  );
}

function chatCurlExample(modelName: string, host: string, port: number, variant: 'v1' | 'api' = 'v1'): string {
  const base = variant === 'v1' ? `http://${host}:${port}/v1` : `http://${host}:${port}/api/v1`;
  return `curl ${base}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelName}","messages":[{"role":"user","content":"Hello!"}],"stream":false}'`;
}

export function ModelsPage({ currentUser, serverStatus, setServerStatus, reloadServerStatus, setPage, onOpenInChat }: { currentUser: UserAccount; serverStatus: ServerStatus | null; setServerStatus: React.Dispatch<React.SetStateAction<ServerStatus | null>>; reloadServerStatus: () => Promise<void>; setPage?: (page: Page) => void; onOpenInChat?: (modelName: string) => void }) {
  const isAdmin = currentUser.role === 'admin';
  const { data, error, reload } = useAsyncData<ModelRecord[]>(async () => { await invoke('scan_model_store'); return invoke('list_models'); }, []);
  const loadedStatus = useAsyncData<LoadedModelStatus[]>(() => invoke('loaded_model_status'), []);
  const modelStore = useAsyncData<string>(() => invoke('get_model_store_dir'), []);
  const systemMemory = useAsyncData<SystemMemory>(() => invoke('get_system_memory'), []);
  useEffect(() => {
    const id = setInterval(() => { void loadedStatus.reload(); }, 4000);
    return () => clearInterval(id);
  }, [loadedStatus.reload]);
  useEffect(() => {
    const id = setInterval(() => { void reload(); }, 8000);
    return () => clearInterval(id);
  }, [reload]);
  const [message, setMessage] = useState<string | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [hfSearch, setHfSearch] = useState('');
  const [hfModels, setHfModels] = useState<HuggingFaceModel[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [hfDownloading, setHfDownloading] = useState<string | null>(null);
  const [hfDownloadProgress, setHfDownloadProgress] = useState<DownloadProgressPayload | null>(null);
  const [selectedHfModelId, setSelectedHfModelId] = useState<string | null>(null);
  const [selectedHfFileKey, setSelectedHfFileKey] = useState<string | null>(null);
  const [hfFormatFilter, setHfFormatFilter] = useState<HfFormatFilter>('all');
  const [hfSort, setHfSort] = useState<string>('downloads');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const [selectedLoadedName, setSelectedLoadedName] = useState<string | null>(null);
  const [contextLength, setContextLength] = useState<number>(4096);
  const [nThreads, setNThreads] = useState<number | ''>(10);
  const [loadSettings, setLoadSettings] = useState<ModelLoadSettings>(defaultModelLoadSettings);
  const [stopStringInput, setStopStringInput] = useState('');
  const [settingsSectionOpen, setSettingsSectionOpen] = useState(true);
  const [samplingSectionOpen, setSamplingSectionOpen] = useState(true);
  const [modelLoading, setModelLoading] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<number | null>(null);
  const [modelToDelete, setModelToDelete] = useState<ModelRecord | null>(null);
  const [downloadToast, setDownloadToast] = useState<{ message: string; key: number } | null>(null);
  const [downloads, setDownloads] = useState<Map<string, DownloadEntry>>(new Map());
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloadsFilter, setDownloadsFilter] = useState('');
  const [loadModelOpen, setLoadModelOpen] = useState(false);
  const [loadModelSearch, setLoadModelSearch] = useState('');
  const [mmprojectPathInput, setMmprojPathInput] = useState('');
  const [savingMmproj, setSavingMmproj] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [modelsShown, setModelsShown] = useState('25');
  const [modelsPage, setModelsPage] = useState(0);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const isRunning = serverStatus?.state === 'running';
  const host = serverStatus?.host === '0.0.0.0' ? 'localhost' : (serverStatus?.host ?? '127.0.0.1');
  const port = serverStatus?.port ?? 1234;

  const refresh = async () => { await reload(); await loadedStatus.reload(); await reloadServerStatus(); };

  const toggleServer = async () => {
    setMessage(null);
    const previous = serverStatus;
    setServerStatus({
      state: isRunning ? 'stopped' : 'running',
      host,
      port,
      error: null,
    });
    try {
      const next = await invoke<ServerStatus>(isRunning ? 'stop_server' : 'start_server', { requesterRole: currentUser.role });
      setServerStatus(next);
    }
    catch (err) {
      setServerStatus(previous);
      setMessage(String(err));
    }
  };

  const importModel = async () => {
    setMessage(null);
    try { await invoke('import_model', { path: importPath }); setImportPath(''); setImportOpen(false); await reload(); }
    catch (err) { setMessage(String(err)); }
  };

  const downloadHuggingFaceModel = async (files: Array<{ url: string; name: string }>, label: string, totalSize: number | null = null) => {
    setMessage(null);
    setHfError(null);
    const downloadId = files.map(file => file.url).join('|');
    setHfDownloading(downloadId);
    setHfDownloadProgress(null);
    // Register in downloads panel
    setDownloads(prev => {
      const next = new Map(prev);
      next.set(downloadId, { id: downloadId, label, sizeBytes: totalSize, downloadedBytes: 0, totalBytes: totalSize, status: 'downloading', startedAt: Date.now(), partIndex: 1, partTotal: files.length });
      return next;
    });
    setDownloadsOpen(true);
    try {
      for (const [index, file] of files.entries()) {
        await invoke('download_model', {
          url: file.url,
          fileName: file.name,
          requesterRole: currentUser.role,
          downloadId,
          partIndex: index + 1,
          partTotal: files.length,
        });
      }
      await reload();
      await modelStore.reload();
      setDownloads(prev => {
        const next = new Map(prev);
        const entry = next.get(downloadId);
        if (entry) next.set(downloadId, { ...entry, status: 'done' });
        return next;
      });
    } catch (err) {
      const msg = String(err);
      setDownloads(prev => {
        const next = new Map(prev);
        const entry = next.get(downloadId);
        if (entry) next.set(downloadId, { ...entry, status: msg.toLowerCase().includes('cancel') ? 'cancelled' : 'error' });
        return next;
      });
      if (!msg.toLowerCase().includes('cancel')) setHfError(msg);
    } finally {
      setHfDownloading(null);
      setHfDownloadProgress(null);
    }
  };

  const deleteDownloadedHuggingFaceModel = async (models: ModelRecord[], label: string) => {
    setMessage(null);
    setHfError(null);
    const uniqueModels = Array.from(new Map(models.map(model => [model.id, model])).values());
    if (!window.confirm(`Delete ${label} from the model folder? This cannot be undone.`)) return;
    const deleteId = `delete:${uniqueModels.map(model => model.id).join(',')}`;
    setHfDownloading(deleteId);
    setHfDownloadProgress(null);
    try {
      for (const model of uniqueModels) {
        await invoke('delete_model', { modelId: model.id, requesterRole: currentUser.role });
      }
      await refresh();
      await modelStore.reload();
      setMessage(`Deleted ${label} from the model folder.`);
    } catch (err) {
      setHfError(String(err));
    } finally {
      setHfDownloading(null);
    }
  };

  const convertHuggingFaceModel = async (model: HuggingFaceModel) => {
    const modelId = huggingFaceModelId(model);
    const files = huggingFaceConvertibleFiles(model);
    setMessage(null);
    setHfError(null);
    setHfDownloading(`convert:${modelId}`);
    setHfDownloadProgress(null);
    try {
      await invoke('download_and_convert_hf_model', {
        modelId,
        files,
        requesterRole: currentUser.role,
        outtype: 'q8_0',
      });
      await refresh();
      await modelStore.reload();
      showDownloadToast(`${modelId.split('/').pop() ?? modelId} converted to GGUF`);
    } catch (err) {
      setHfError(String(err));
    } finally {
      setHfDownloading(null);
      setHfDownloadProgress(null);
    }
  };

  const openHuggingFaceModel = async (modelId: string) => {
    const url = huggingFaceModelUrl(modelId);
    try {
      await invoke('open_external_url', { url });
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const loadHuggingFaceModels = useCallback(async (search: string, format: HfFormatFilter, sort: string) => {
    setHfLoading(true);
    setHfError(null);
    try {
      const params = new URLSearchParams({
        direction: '-1',
        limit: '24',
        full: 'true',
        config: 'true',
      });
      if (sort) params.set('sort', sort);
      if (search.trim()) params.set('search', search.trim());
      if (format === 'gguf') params.set('filter', 'gguf');
      if (format === 'transformer') params.set('filter', 'safetensors');
      const response = await fetch(`https://huggingface.co/api/models?${params.toString()}`);
      if (!response.ok) throw new Error(`Hugging Face returned ${response.status}`);
      const models = await response.json() as HuggingFaceModel[];
      const enriched = await Promise.all(models.map(async (model) => {
        const modelId = huggingFaceModelId(model);
        if (modelId === 'unknown') return model;
        try {
          const detail = await fetch(`${huggingFaceApiModelUrl(modelId)}?blobs=true&config=true`);
          const detailedModel = detail.ok ? { ...model, ...await detail.json() as HuggingFaceModel } : model;
          return await enrichHuggingFaceFileSizes(detailedModel);
        } catch {
          return await enrichHuggingFaceFileSizes(model);
        }
      }));
      setHfModels(enriched);
      setSelectedHfModelId(current => current && enriched.some(model => huggingFaceModelId(model) === current) ? current : huggingFaceModelId(enriched[0] ?? {}));
    } catch (err) {
      setHfError(String(err));
    } finally {
      setHfLoading(false);
    }
  }, []);

  const ejectModel = async (modelName?: string) => {
    setMessage(null);
    try { await invoke('eject_model', { modelName: modelName ?? null, requesterRole: currentUser.role }); await refresh(); }
    catch (err) { setMessage(String(err)); }
  };

  const saveMmproj = async () => {
    if (!selectedModel) return;
    setSavingMmproj(true);
    setMessage(null);
    try {
      const updated = await invoke<ModelRecord>('set_model_mmproj_path', {
        modelId: selectedModel.id,
        mmprojPath: mmprojectPathInput.trim() || null,
        requesterRole: currentUser.role,
      });
      setMmprojPathInput(updated.mmproj_path ?? '');
      await reload();
      setMessage(`Multimodal projector path saved for ${selectedModel.name}.`);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSavingMmproj(false);
    }
  };

  const showDownloadToast = (message: string) => {
    const key = Date.now();
    setDownloadToast({ message, key });
    window.setTimeout(() => setDownloadToast(prev => prev?.key === key ? null : prev), 5000);
  };

  const requestDeleteModel = (event: React.MouseEvent, model: ModelRecord) => {
    event.preventDefault();
    event.stopPropagation();
    setMessage(null);
    setModelToDelete(model);
  };

  const confirmDeleteModel = async () => {
    const model = modelToDelete;
    if (!model) return;
    setMessage(null);
    setDeletingModelId(model.id);
    try {
      await invoke('delete_model', { modelId: model.id, requesterRole: currentUser.role });
      if (selectedModelId === model.id) {
        setSelectedModelId(null);
        setSelectedLoadedName(null);
      }
      await refresh();
      await modelStore.reload();
      setMessage(`Deleted ${model.name} from the model folder.`);
      setModelToDelete(null);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setDeletingModelId(null);
    }
  };

  const loadableModels = (data ?? []).filter(m => m.status !== 'unsupported');
  const readyModels = loadableModels;
  const modelsPageData = paginateRows(data ?? [], modelsPage, modelsShown);
  const visibleModels = modelsPageData.rows;
  const loadedStatuses = loadedStatus.data ?? [];
  const activeLoadedStatuses = loadedStatuses.filter(s => s.loaded && s.model_id !== null && s.model_name);
  const loadedByName = new Map(activeLoadedStatuses.map(s => [s.model_name as string, s]));
  const loadedBaseIds = new Set(activeLoadedStatuses.map(s => s.model_id as number));
  const loadedModels = activeLoadedStatuses
    .map(status => {
      const base = (data ?? []).find(model => model.id === status.model_id);
      return base ? { ...base, name: status.model_name ?? base.name, baseName: base.name } : null;
    })
    .filter((model): model is ModelRecord & { baseName: string } => model !== null);
  const selectedLoadedStatus = selectedLoadedName ? loadedByName.get(selectedLoadedName) ?? null : null;
  const selectedModel = (selectedLoadedStatus ? (data ?? []).find(m => m.id === selectedLoadedStatus.model_id) : null) ?? (data ?? []).find(m => m.id === selectedModelId) ?? (loadedModels[0] ? (data ?? []).find(m => m.id === loadedModels[0].id) : null) ?? readyModels[0] ?? null;
  const selectedIsLoaded = Boolean(selectedLoadedStatus?.loaded);
  const selectedIsLoadable = Boolean(selectedModel && selectedModel.status !== 'unsupported');
  const contextLengthMax = selectedModel?.context_length_max ?? 131072;
  const loadControlsDisabled = modelLoading || !selectedModel || (!selectedIsLoaded && !selectedIsLoadable);
  const setClampedContextLength = (value: number) => setContextLength(Math.min(contextLengthMax, Math.max(512, Number(value) || 4096)));
  const currentLoadSettings = { ...loadSettings };
  const settingsChanged = Boolean(selectedIsLoaded && selectedLoadedStatus && (
    contextLength !== (selectedLoadedStatus.context_length ?? 4096) ||
    (nThreads === '' ? 10 : nThreads) !== (selectedLoadedStatus.n_threads ?? 10) ||
    JSON.stringify(currentLoadSettings) !== JSON.stringify(selectedLoadedStatus.load_settings ?? defaultModelLoadSettings)
  ));
  const runtimeError = loadedStatuses.find(s => s.error)?.error ?? null;
  const mcpConfig = JSON.stringify({ mcpServers: { llmeter: { url: `http://${host}:${port}/sse` } } }, null, 2);
  const filteredHfModels = React.useMemo(() => hfModels.filter(model => {
    if (hfFormatFilter === 'gguf') return huggingFaceGgufFiles(model).length > 0;
    if (hfFormatFilter === 'transformer') return huggingFaceTransformerFiles(model).length > 0;
    return true;
  }), [hfModels, hfFormatFilter]);
  const selectedHfModel = filteredHfModels.find(model => huggingFaceModelId(model) === selectedHfModelId) ?? filteredHfModels[0] ?? null;
  const selectedHfModelIdValue = selectedHfModel ? huggingFaceModelId(selectedHfModel) : 'unknown';
  const selectedHfFiles = selectedHfModel ? huggingFaceGgufFiles(selectedHfModel) : [];
  const selectedHfConvertibleFiles = selectedHfModel ? huggingFaceConvertibleFiles(selectedHfModel) : [];
  const convertDownloadId = `convert:${selectedHfModelIdValue}`;
  const activeHfFile = selectedHfFiles.find(f => f.key === selectedHfFileKey) ?? selectedHfFiles[0] ?? null;
  const convertProgress = hfDownloadProgress?.download_id === convertDownloadId ? hfDownloadProgress : null;
  const convertProgressValue = convertProgress?.total_bytes ? Math.min(100, Math.round((convertProgress.downloaded_bytes / convertProgress.total_bytes) * 1000) / 10) : null;
  const downloadedModelsByFile = new Map<string, ModelRecord[]>();
  for (const model of data ?? []) {
    const key = fileBaseName(model.path);
    downloadedModelsByFile.set(key, [...(downloadedModelsByFile.get(key) ?? []), model]);
  }
  const filteredPickerModels = React.useMemo(() =>
    loadableModels.filter(m =>
      !loadModelSearch.trim() || m.name.toLowerCase().includes(loadModelSearch.toLowerCase())
    ),
    [loadableModels, loadModelSearch]
  );

  const loadSpecificModel = async (model: ModelRecord) => {
    setMessage(null);
    setModelLoading(true);
    setLoadModelOpen(false);
    setLoadModelSearch('');
    try {
      await invoke('load_model', {
        modelId: model.id,
        contextLength,
        nThreads: nThreads === '' ? 10 : nThreads,
        loadSettings: currentLoadSettings,
        requesterRole: currentUser.role,
      });
      await refresh();
      setSelectedLoadedName(null);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setModelLoading(false);
    }
  };

  const applySelectedModelSettings = async () => {
    if (!selectedModel) return;
    setMessage(null);
    setModelLoading(true);
    try {
      if (selectedIsLoaded) {
        await invoke('eject_model', { modelName: selectedLoadedStatus?.model_name ?? null, requesterRole: currentUser.role });
      }
      await invoke('load_model', {
        modelId: selectedModel.id,
        contextLength,
        nThreads: nThreads === '' ? 10 : nThreads,
        loadSettings: currentLoadSettings,
        requesterRole: currentUser.role,
      });
      await refresh();
      setSelectedLoadedName(null);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setModelLoading(false);
    }
  };

  useEffect(() => {
    const models = data ?? [];
    if (models.length === 0) {
      setSelectedModelId(null);
      return;
    }
    if (!selectedModelId || !models.some(model => model.id === selectedModelId)) {
      setSelectedModelId((loadedModels[0] ?? readyModels[0] ?? models[0]).id);
    }
  }, [data, loadedModels, readyModels, selectedModelId]);

  useEffect(() => {
    if (selectedLoadedStatus) {
      setClampedContextLength(selectedLoadedStatus.context_length ?? 4096);
      setNThreads(selectedLoadedStatus.n_threads ?? 10);
      setLoadSettings(selectedLoadedStatus.load_settings ?? defaultModelLoadSettings);
    } else if (selectedModel) {
      setClampedContextLength(4096);
      setNThreads(10);
      setLoadSettings(defaultModelLoadSettings);
      setStopStringInput('');
    }
    setMmprojPathInput(selectedModel?.mmproj_path ?? '');
  }, [selectedModel?.id, selectedLoadedStatus?.model_name]);

  useEffect(() => {
    if (!importOpen) return;
    void systemMemory.reload();
    const timer = window.setTimeout(() => {
      void loadHuggingFaceModels(hfSearch, hfFormatFilter, hfSort);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [importOpen, hfSearch, hfFormatFilter, hfSort, loadHuggingFaceModels]);

  useEffect(() => {
    setSelectedHfModelId(current => current && filteredHfModels.some(model => huggingFaceModelId(model) === current) ? current : huggingFaceModelId(filteredHfModels[0] ?? {}));
  }, [filteredHfModels]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    listen<DownloadProgressPayload>('model-download-progress', event => {
      if (!active) return;
      setHfDownloadProgress(event.payload);
      // Keep downloads panel in sync
      const p = event.payload;
      setDownloads(prev => {
        const entry = prev.get(p.download_id);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(p.download_id, {
          ...entry,
          downloadedBytes: p.downloaded_bytes,
          totalBytes: p.total_bytes ?? entry.totalBytes,
          partIndex: p.part_index,
          partTotal: p.part_total,
          status: p.status === 'done' ? 'done' : p.status === 'cancelled' ? 'cancelled' : 'downloading',
        });
        return next;
      });
    }).then(dispose => {
      if (active) {
        unlisten = dispose;
      } else {
        dispose();
      }
    }).catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const cancelDownload = async (downloadId: string) => {
    try { await invoke('cancel_download', { downloadId }); } catch {}
  };

  // Poll llama-server logs every 1.5 s
  useEffect(() => {
    if (!isAdmin) return;
    const id = setInterval(async () => {
      try { setLogLines(await invoke<string[]>('get_model_logs', { requesterRole: currentUser.role })); } catch {}
    }, 1500);
    return () => clearInterval(id);
  }, [isAdmin, currentUser.role]);

  // Auto-scroll within the log container only when already near the bottom
  useEffect(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // Auto-select the first loaded model so the settings panel is visible without a manual click
  const firstLoadedModelName = activeLoadedStatuses[0]?.model_name ?? null;
  useEffect(() => {
    if (firstLoadedModelName && !selectedLoadedName) {
      setSelectedLoadedName(firstLoadedModelName);
    } else if (!firstLoadedModelName) {
      setSelectedLoadedName(null);
    }
  }, [firstLoadedModelName]);

  return (
    <Stack w="100%">
        <Header
          title="Server"
          subtitle="Control the local API server, load models into RAM, and manage the model store."
          onRefresh={refresh}
        />
        {message ? <StatusCard message={message} /> : null}
        {error || runtimeError ? <ErrorCard message={error ?? runtimeError ?? ''} /> : null}

        <Tabs defaultValue="server">
          <Tabs.List>
            <Tabs.Tab value="server">Server</Tabs.Tab>
            <Tabs.Tab value="models">Models</Tabs.Tab>
          </Tabs.List>

          {/* ── Server tab ── */}
          <Tabs.Panel value="server" pt="md">
            <Group align="flex-start" gap="md" wrap="nowrap">
              {/* ── Left column ── */}
              <Stack style={{ flex: 1, minWidth: 0 }}>
                {isAdmin && (
                  <Card withBorder p="md" className="serverControlCard">
                    <Group justify="space-between">
                      <Group gap="md">
                        <Group gap="xs">
                          <Text size="sm" fw={600} c={isRunning ? 'green' : 'dimmed'}>
                            {isRunning ? 'Running' : 'Stopped'}
                          </Text>
                          <Switch checked={isRunning} onChange={toggleServer} size="sm" />
                        </Group>
                        <div className="serverControlCopy">
                          <Text fw={800} size="sm">{isRunning ? 'API server is accepting client requests' : 'Control service is awake'}</Text>
                          <Text c="dimmed" size="xs">
                            {isRunning ? `Clients can use http://${host}:${port}/v1 and /api/v1/chat.` : 'You can still list, import, load, and eject models while the API server is stopped.'}
                          </Text>
                        </div>
                      </Group>
                      <Group gap="sm">
                        {isRunning
                          ? <Tooltip label="Copy base URL" withArrow><Button size="sm" variant="subtle" color="dimmed" leftSection={<Bi name="copy" />} onClick={() => navigator.clipboard.writeText(`http://${host}:${port}`)}>{`http://${host}:${port}`}</Button></Tooltip>
                          : <Text c="dimmed" size="sm">API server stopped</Text>}
                        <Button size="sm" variant="default" onClick={() => setSettingsOpen(true)}>Settings</Button>
                      </Group>
                    </Group>
                  </Card>
                )}

                <Group justify="space-between" align="center">
                  <Title order={3}>Loaded Models</Title>
                  {isAdmin && (
                    <Button size="sm" leftSection={<Bi name="play-fill" />} onClick={() => setLoadModelOpen(true)} loading={modelLoading}>
                      Load Model
                    </Button>
                  )}
                </Group>

                {loadedModels.length > 0 ? (
                  <Stack gap="sm">
                    {loadedModels.map((loadedModel) => {
                      const status = loadedByName.get(loadedModel.name);
                      const selected = selectedLoadedName === loadedModel.name;
                      const modelSettingsChanged = selected && settingsChanged;
                      return (
                        <Card key={loadedModel.name} withBorder p={0} className={selected ? 'loadedModelCard selected' : 'loadedModelCard'} onClick={() => { setSelectedModelId(loadedModel.id); setSelectedLoadedName(loadedModel.name); }}>
                          {/* Status bar */}
                          <Group justify="space-between" px="md" pt="xs" pb="xs" style={{ borderBottom: '1px solid var(--mantine-color-dark-5)' }}>
                            <Group gap="xs">
                              <Badge color="green" variant="light" size="sm">READY</Badge>
                              {modelSettingsChanged && (
                                <Badge color="orange" variant="light" size="sm">
                                  <Group gap={4} wrap="nowrap"><Bi name="exclamation-triangle" />RELOAD NEEDED</Group>
                                </Badge>
                              )}
                            </Group>
                            <i className="bi bi-chevron-right" style={{ color: 'var(--muted)', fontSize: 12 }} />
                          </Group>
                          {/* Main row */}
                          <Group justify="space-between" px="md" py="sm" wrap="nowrap">
                            <Group gap="xs" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                              <Badge variant="default" radius="sm" size="sm" style={{ flexShrink: 0 }}>llm</Badge>
                              <Text className="mono" c="teal" fw={600} size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loadedModel.name}</Text>
                              <ActionIcon variant="subtle" size="sm" title="Open in Chat" style={{ flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); onOpenInChat?.(loadedModel.name); setPage?.('chat'); }}><Bi name="eye" /></ActionIcon>
                              <ActionIcon variant="subtle" size="sm" title="Copy model name" style={{ flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(loadedModel.name); }}><Bi name="copy" /></ActionIcon>
                              <Menu withinPortal position="bottom-start">
                                <Menu.Target>
                                  <Button size="xs" variant="default" style={{ flexShrink: 0 }} rightSection={<Bi name="chevron-down" />} onClick={e => e.stopPropagation()}>
                                    {'<>'} cURL
                                  </Button>
                                </Menu.Target>
                                <Menu.Dropdown onClick={e => e.stopPropagation()}>
                                  <Menu.Label>Copy example request</Menu.Label>
                                  <Menu.Item leftSection={<Bi name="clipboard" />} onClick={() => navigator.clipboard.writeText(chatCurlExample(loadedModel.name, host, port, 'v1'))}>
                                    /v1/chat/completions
                                  </Menu.Item>
                                  <Menu.Item leftSection={<Bi name="clipboard" />} onClick={() => navigator.clipboard.writeText(chatCurlExample(loadedModel.name, host, port, 'api'))}>
                                    /api/v1/chat (legacy)
                                  </Menu.Item>
                                </Menu.Dropdown>
                              </Menu>
                            </Group>
                            <Group gap="md" style={{ flexShrink: 0 }}>
                              <Text size="sm" c="dimmed">Size <Text span fw={700} c="white">{formatBytes(loadedModel.size_bytes)}</Text></Text>
                              {status?.context_length ? <Text size="sm" c="dimmed">Context <Text span fw={700} c="white">{status.context_length.toLocaleString()}</Text></Text> : null}
                              {isAdmin && <Button size="xs" color="red" variant="light" leftSection={<Bi name="eject" />} onClick={(event) => { event.stopPropagation(); void ejectModel(loadedModel.name); }}>Eject</Button>}
                              {isAdmin && <Button size="xs" color="red" variant="light" loading={deletingModelId === loadedModel.id} disabled={deletingModelId !== null && deletingModelId !== loadedModel.id} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => requestDeleteModel(event, loadedModel)}>Delete</Button>}
                            </Group>
                          </Group>
                        </Card>
                      );
                    })}
                  </Stack>
                ) : (
                  <EmptyState
                    title="No model loaded"
                    description={isAdmin ? 'Click "Load Model" to pick a model and load it into RAM. Configure load parameters in the Models tab.' : 'No model is loaded yet. Ask an admin to load one before chatting.'}
                  />
                )}

                {isAdmin && (
                  <Card withBorder p={0} style={{ overflow: 'hidden' }}>
                    <Group justify="space-between" px="md" py="xs" style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}>
                      <Text size="sm" fw={700}>Logs</Text>
                      <Button size="xs" variant="subtle" color="dimmed" onClick={async () => { await invoke('clear_model_logs', { requesterRole: currentUser.role }); setLogLines([]); }}>Clear</Button>
                    </Group>
                    <div ref={logContainerRef} style={{ height: 400, overflowY: 'auto', background: 'var(--mantine-color-dark-9)', padding: '10px 14px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.6 }}>
                      {logLines.length === 0
                        ? <span style={{ color: '#4b5563' }}>No output yet. Load a model to see logs here.</span>
                        : logLines.map((line, i) => <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{renderLogLine(line)}</div>)
                      }
                    </div>
                  </Card>
                )}
              </Stack>

              {/* ── Right column: model settings panel ── */}
              {isAdmin && selectedIsLoaded && (
                <Box w={290} style={{ flexShrink: 0 }}>
                  <Card withBorder p={0} style={{ overflow: 'hidden' }}>
                    {/* Header */}
                    <Box px="md" pt="sm" pb="xs" style={{ borderBottom: '1px solid var(--mantine-color-dark-4)', background: 'rgba(0,0,0,0.18)' }}>
                      <Text size="xs" fw={800} c="dimmed" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10 }}>Model Settings</Text>
                      <Text size="sm" fw={600} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedLoadedStatus?.model_name ?? '—'}</Text>
                    </Box>
                    <Tabs defaultValue="load">
                      <Tabs.List>
                        <Tabs.Tab value="info" fz={12}>Info</Tabs.Tab>
                        <Tabs.Tab value="load" fz={12}>Load</Tabs.Tab>
                        <Tabs.Tab value="inference" fz={12}>Inference</Tabs.Tab>
                      </Tabs.List>
                      <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 360px)' }}>
                        {/* Info */}
                        <Tabs.Panel value="info" p="sm">
                          <Stack gap={2}>
                            {selectedModel && <>
                              <InfoRow label="Size" value={formatBytes(selectedModel.size_bytes)} />
                              <InfoRow label="Format" value={selectedModel.format ?? 'GGUF'} />
                              {selectedModel.context_length_max ? <InfoRow label="Max Context" value={selectedModel.context_length_max.toLocaleString() + ' tokens'} /> : null}
                              {selectedModel.hf_repo ? <InfoRow label="Source" value={selectedModel.hf_repo} /> : null}
                              <InfoRow label="Status" value={selectedModel.status} />
                            </>}
                            {selectedLoadedStatus && <><Divider my={6} /><Text size="xs" c="dimmed" fw={700} style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>Runtime</Text>
                              {selectedLoadedStatus.context_length ? <InfoRow label="Context" value={selectedLoadedStatus.context_length.toLocaleString()} /> : null}
                              {selectedLoadedStatus.n_threads ? <InfoRow label="Threads" value={String(selectedLoadedStatus.n_threads)} /> : null}
                              {selectedLoadedStatus.port ? <InfoRow label="Port" value={`:${selectedLoadedStatus.port}`} /> : null}
                            </>}
                          </Stack>
                        </Tabs.Panel>
                        {/* Load */}
                        <Tabs.Panel value="load" p="sm">
                          <Stack gap="sm">
                            <Text size="xs" fw={800} c="dimmed" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10 }}>Context</Text>
                            <NumberInput size="xs" label="Context Length" description={selectedModel?.context_length_max ? `Up to ${selectedModel.context_length_max.toLocaleString()} tokens` : undefined} min={512} max={contextLengthMax} step={512} value={contextLength} onChange={(v) => setClampedContextLength(Number(v))} disabled={loadControlsDisabled} />
                            <Slider size="xs" min={512} max={contextLengthMax} step={512} value={Math.min(contextLength, contextLengthMax)} onChange={setClampedContextLength} disabled={loadControlsDisabled} className="contextLengthSlider" marks={[{ value: 512, label: '512' }, { value: contextLengthMax, label: contextLengthMax.toLocaleString() }]} />
                            <Text size="xs" fw={800} c="dimmed" mt="xs" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10 }}>Threads</Text>
                            <NumberInput size="xs" label="CPU Threads" description="Inference threads (--threads)" min={1} max={256} value={nThreads} onChange={(v) => setNThreads(v === '' ? '' : Number(v))} disabled={loadControlsDisabled} />
                            <Slider size="xs" min={1} max={64} step={1} value={nThreads === '' ? 10 : Math.min(64, nThreads)} onChange={(value) => setNThreads(value)} disabled={loadControlsDisabled} />
                            <Text size="xs" fw={800} c="dimmed" mt="xs" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10 }}>Multimodal</Text>
                            <TextInput size="xs" label="mmproj Path" placeholder="/path/to/mmproj.gguf" value={mmprojectPathInput} onChange={(e) => setMmprojPathInput(e.currentTarget.value)} disabled={!selectedModel} />
                            {mmprojectPathInput !== (selectedModel?.mmproj_path ?? '') && (
                              <Button size="xs" loading={savingMmproj} onClick={() => void saveMmproj()}>Save projector path</Button>
                            )}
                          </Stack>
                        </Tabs.Panel>
                        {/* Inference */}
                        <Tabs.Panel value="inference" p="sm">
                          <Stack gap="sm">
                            <NumberInput size="xs" label="Temperature" min={0} max={2} step={0.1} decimalScale={2} value={loadSettings.temperature} onChange={(v) => setLoadSettings({ ...loadSettings, temperature: Number(v) || 0 })} disabled={loadControlsDisabled} />
                            <Slider size="xs" min={0} max={2} step={0.05} value={loadSettings.temperature} onChange={(value) => setLoadSettings({ ...loadSettings, temperature: value })} disabled={loadControlsDisabled} />
                            <Checkbox size="xs" labelPosition="right" label="Limit Response Length" checked={loadSettings.limit_response_length} onChange={(e) => setLoadSettings({ ...loadSettings, limit_response_length: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                            {loadSettings.limit_response_length ? <NumberInput size="xs" label="Max Tokens" min={1} max={131072} value={loadSettings.max_tokens ?? 2048} onChange={(v) => setLoadSettings({ ...loadSettings, max_tokens: Number(v) || 2048 })} disabled={loadControlsDisabled} /> : null}
                            <Select size="xs" label="Context Overflow" data={[{ value: 'truncate_middle', label: 'Truncate Middle' }, { value: 'truncate_start', label: 'Truncate Start' }, { value: 'error', label: 'Error' }]} value={loadSettings.context_overflow} onChange={(value) => setLoadSettings({ ...loadSettings, context_overflow: value ?? 'truncate_middle' })} disabled={loadControlsDisabled} />
                            <Divider label="Sampling" labelPosition="left" my={4} />
                            <NumberInput size="xs" label="Top K" min={0} max={1000} value={loadSettings.top_k ?? 40} onChange={(v) => setLoadSettings({ ...loadSettings, top_k: Number(v) || 0 })} disabled={loadControlsDisabled} />
                            <Checkbox size="xs" labelPosition="right" label="Repeat Penalty" checked={loadSettings.repeat_penalty_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, repeat_penalty_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                            {loadSettings.repeat_penalty_enabled ? <NumberInput size="xs" min={0} max={4} step={0.05} decimalScale={2} value={loadSettings.repeat_penalty ?? 1.1} onChange={(v) => setLoadSettings({ ...loadSettings, repeat_penalty: Number(v) || 1.1 })} disabled={loadControlsDisabled} /> : null}
                            <Checkbox size="xs" labelPosition="right" label="Presence Penalty" checked={loadSettings.presence_penalty_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, presence_penalty_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                            {loadSettings.presence_penalty_enabled ? <NumberInput size="xs" min={-2} max={2} step={0.05} decimalScale={2} value={loadSettings.presence_penalty ?? 0} onChange={(v) => setLoadSettings({ ...loadSettings, presence_penalty: Number(v) || 0 })} disabled={loadControlsDisabled} /> : null}
                            <Checkbox size="xs" labelPosition="right" label="Top P" checked={loadSettings.top_p_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, top_p_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                            {loadSettings.top_p_enabled ? <><NumberInput size="xs" min={0} max={1} step={0.01} decimalScale={2} value={loadSettings.top_p ?? 0.95} onChange={(v) => setLoadSettings({ ...loadSettings, top_p: Number(v) || 0.95 })} disabled={loadControlsDisabled} /><Slider size="xs" min={0} max={1} step={0.01} value={loadSettings.top_p ?? 0.95} onChange={(value) => setLoadSettings({ ...loadSettings, top_p: value })} disabled={loadControlsDisabled} /></> : null}
                            <Checkbox size="xs" labelPosition="right" label="Min P" checked={loadSettings.min_p_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, min_p_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                            {loadSettings.min_p_enabled ? <><NumberInput size="xs" min={0} max={1} step={0.01} decimalScale={2} value={loadSettings.min_p ?? 0.05} onChange={(v) => setLoadSettings({ ...loadSettings, min_p: Number(v) || 0.05 })} disabled={loadControlsDisabled} /><Slider size="xs" min={0} max={1} step={0.01} value={loadSettings.min_p ?? 0.05} onChange={(value) => setLoadSettings({ ...loadSettings, min_p: value })} disabled={loadControlsDisabled} /></> : null}
                          </Stack>
                        </Tabs.Panel>
                      </div>
                    </Tabs>
                    {/* Reload button */}
                    {settingsChanged && (
                      <Box p="xs" style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}>
                        <Button fullWidth size="sm" color="orange" variant="filled" leftSection={<Bi name="arrow-repeat" />} onClick={applySelectedModelSettings} loading={modelLoading}>
                          Reload to apply changes
                        </Button>
                      </Box>
                    )}
                  </Card>
                </Box>
              )}
            </Group>
          </Tabs.Panel>

          {/* ── Models tab ── */}
          <Tabs.Panel value="models" pt="md">
            <Group align="flex-start" gap="md" wrap="nowrap" style={{ width: '100%' }}>
              <Stack style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <Group justify="space-between" align="center">
                  <Title order={3}>Available Models</Title>
                  <TableControls shown={modelsShown} onShownChange={(value) => { setModelsShown(value); setModelsPage(0); }} page={modelsPageData.page} totalPages={modelsPageData.totalPages} onPageChange={setModelsPage}>
                    {isAdmin && <Button size="xs" variant="default" onClick={() => setImportOpen(true)}>↓ Import Model</Button>}
                  </TableControls>
                </Group>
                <Card withBorder>
                  <Table.ScrollContainer minWidth={600}>
                    <Table highlightOnHover>
                      <Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>Type / Inputs</Table.Th><Table.Th>Status</Table.Th><Table.Th>Size</Table.Th>{isAdmin ? <Table.Th>Action</Table.Th> : null}</Table.Tr></Table.Thead>
                      <Table.Tbody>
                        {visibleModels.map(model => (
                          <Table.Tr key={model.id} className={selectedModel?.id === model.id && !selectedLoadedName ? 'selectableModelRow selected' : 'selectableModelRow'} onClick={() => { setSelectedModelId(model.id); setSelectedLoadedName(null); }}>
                            <Table.Td>{model.name}</Table.Td>
                            <Table.Td><ModelTypeBadge model={model} /></Table.Td>
                            <Table.Td><Badge color={loadedBaseIds.has(model.id) ? 'green' : 'gray'} variant={loadedBaseIds.has(model.id) ? 'light' : 'outline'}>{loadedBaseIds.has(model.id) ? 'loaded' : 'unloaded'}</Badge></Table.Td>
                            <Table.Td>{formatBytes(model.size_bytes)}</Table.Td>
                            {isAdmin ? <Table.Td><Button size="xs" color="red" variant="light" loading={deletingModelId === model.id} disabled={deletingModelId !== null && deletingModelId !== model.id} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => requestDeleteModel(event, model)}>Delete</Button></Table.Td> : null}
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                  {(data?.length ?? 0) === 0 ? <EmptyState title="No imported models" description={isAdmin ? 'Import a local GGUF file or download a compatible model from Hugging Face to get started.' : 'No models are available yet. Ask an admin to import or download one.'} compact /> : null}
                </Card>
              </Stack>

              {isAdmin && (
                <Stack w={320} style={{ flexShrink: 0 }}>
                  <Card withBorder p={0} className="loadSettingsCard">
                    <Stack gap="md">
                      <div className="loadSettingsIntro">
                        <Text fw={700} size="sm">Load Settings</Text>
                        {selectedModel ? <Text size="xs" c="dimmed">{selectedIsLoaded ? 'Editing' : 'Ready to load'} <Text span c="teal" fw={700}>{selectedModel.name}</Text>. {selectedIsLoaded ? 'Applying changes ejects and reloads this model.' : 'Choose settings, then load via the Server tab or the button below.'}</Text> : <Text size="xs" c="dimmed">Select a model to configure it before loading.</Text>}
                      </div>
                      <LoadSettingsSection title="Settings" open={settingsSectionOpen} onToggle={() => setSettingsSectionOpen(!settingsSectionOpen)}>
                        <NumberInput label="Temperature" min={0} max={2} step={0.1} decimalScale={2} value={loadSettings.temperature} onChange={(v) => setLoadSettings({ ...loadSettings, temperature: Number(v) || 0 })} disabled={loadControlsDisabled} />
                        <Slider min={0} max={2} step={0.05} value={loadSettings.temperature} onChange={(value) => setLoadSettings({ ...loadSettings, temperature: value })} disabled={loadControlsDisabled} />
                        <Checkbox labelPosition="right" label="Limit Response Length" checked={loadSettings.limit_response_length} onChange={(e) => setLoadSettings({ ...loadSettings, limit_response_length: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                        {loadSettings.limit_response_length ? <NumberInput label="Max Tokens" min={1} max={131072} value={loadSettings.max_tokens ?? 2048} onChange={(v) => setLoadSettings({ ...loadSettings, max_tokens: Number(v) || 2048 })} disabled={loadControlsDisabled} /> : null}
                        <Select label="Context Overflow" data={[{ value: 'truncate_middle', label: 'Truncate Middle' }, { value: 'truncate_start', label: 'Truncate Start' }, { value: 'error', label: 'Error' }]} value={loadSettings.context_overflow} onChange={(value) => setLoadSettings({ ...loadSettings, context_overflow: value ?? 'truncate_middle' })} disabled={loadControlsDisabled} />
                        <TextInput label="Stop Strings" placeholder="Enter a string and press Enter" value={stopStringInput} disabled={loadControlsDisabled} onChange={(e) => setStopStringInput(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const value = stopStringInput.trim(); if (value && !loadSettings.stop_strings.includes(value)) { setLoadSettings({ ...loadSettings, stop_strings: [...loadSettings.stop_strings, value] }); setStopStringInput(''); } } }} />
                        {loadSettings.stop_strings.length > 0 ? <Group gap="xs">{loadSettings.stop_strings.map(stop => <Badge key={stop} variant="light" color="gray" style={{ cursor: 'pointer' }} onClick={() => setLoadSettings({ ...loadSettings, stop_strings: loadSettings.stop_strings.filter(item => item !== stop) })}>{stop} ×</Badge>)}</Group> : null}
                        <NumberInput label="Context Length" description={selectedModel?.context_length_max ? `Token window size (--ctx-size), max ${selectedModel.context_length_max.toLocaleString()}` : 'Token window size (--ctx-size). Max unknown; using safe fallback.'} min={512} max={contextLengthMax} step={512} value={contextLength} onChange={(v) => setClampedContextLength(Number(v))} disabled={loadControlsDisabled} />
                        <Slider className="contextLengthSlider" min={512} max={contextLengthMax} step={512} value={Math.min(contextLength, contextLengthMax)} onChange={setClampedContextLength} disabled={loadControlsDisabled} marks={[{ value: 512, label: '512' }, { value: contextLengthMax, label: contextLengthMax.toLocaleString() }]} />
                        <NumberInput label="CPU Threads" description="Threads for inference (--threads)" min={1} max={256} value={nThreads} onChange={(v) => setNThreads(v === '' ? '' : Number(v))} disabled={loadControlsDisabled} />
                        <Slider min={1} max={64} step={1} value={nThreads === '' ? 10 : Math.min(64, nThreads)} onChange={(value) => setNThreads(value)} disabled={loadControlsDisabled} />
                        <div>
                          <TextInput
                            label="Multimodal Projector (mmproj)"
                            description="Path to the mmproj GGUF file required for vision input. Downloaded automatically for HuggingFace models."
                            placeholder="/path/to/mmproj-model-f16.gguf"
                            value={mmprojectPathInput}
                            onChange={(e) => setMmprojPathInput(e.currentTarget.value)}
                            disabled={!selectedModel}
                          />
                          {mmprojectPathInput !== (selectedModel?.mmproj_path ?? '') && (
                            <Button mt="xs" size="xs" loading={savingMmproj} onClick={() => void saveMmproj()}>Save projector path</Button>
                          )}
                          {selectedModel?.mmproj_path && mmprojectPathInput === selectedModel.mmproj_path && (
                            <Text size="xs" c="teal" mt={4}>Projector loaded — vision input enabled.</Text>
                          )}
                        </div>
                      </LoadSettingsSection>
                      <LoadSettingsSection title="Sampling" open={samplingSectionOpen} onToggle={() => setSamplingSectionOpen(!samplingSectionOpen)}>
                        <NumberInput label="Top K Sampling" min={0} max={1000} value={loadSettings.top_k ?? 40} onChange={(v) => setLoadSettings({ ...loadSettings, top_k: Number(v) || 0 })} disabled={loadControlsDisabled} />
                        <Checkbox labelPosition="right" label="Repeat Penalty" checked={loadSettings.repeat_penalty_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, repeat_penalty_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                        <NumberInput min={0} max={4} step={0.05} decimalScale={2} value={loadSettings.repeat_penalty ?? 1.1} onChange={(v) => setLoadSettings({ ...loadSettings, repeat_penalty: Number(v) || 1.1 })} disabled={loadControlsDisabled || !loadSettings.repeat_penalty_enabled} />
                        <Checkbox labelPosition="right" label="Presence Penalty" checked={loadSettings.presence_penalty_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, presence_penalty_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                        <NumberInput min={-2} max={2} step={0.05} decimalScale={2} value={loadSettings.presence_penalty ?? 0} onChange={(v) => setLoadSettings({ ...loadSettings, presence_penalty: Number(v) || 0 })} disabled={loadControlsDisabled || !loadSettings.presence_penalty_enabled} />
                        <Checkbox labelPosition="right" label="Top P Sampling" checked={loadSettings.top_p_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, top_p_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                        <NumberInput min={0} max={1} step={0.01} decimalScale={2} value={loadSettings.top_p ?? 0.95} onChange={(v) => setLoadSettings({ ...loadSettings, top_p: Number(v) || 0.95 })} disabled={loadControlsDisabled || !loadSettings.top_p_enabled} />
                        <Slider min={0} max={1} step={0.01} value={loadSettings.top_p ?? 0.95} onChange={(value) => setLoadSettings({ ...loadSettings, top_p: value })} disabled={loadControlsDisabled || !loadSettings.top_p_enabled} />
                        <Checkbox labelPosition="right" label="Min P Sampling" checked={loadSettings.min_p_enabled} onChange={(e) => setLoadSettings({ ...loadSettings, min_p_enabled: e.currentTarget.checked })} disabled={loadControlsDisabled} />
                        <NumberInput min={0} max={1} step={0.01} decimalScale={2} value={loadSettings.min_p ?? 0.05} onChange={(v) => setLoadSettings({ ...loadSettings, min_p: Number(v) || 0.05 })} disabled={loadControlsDisabled || !loadSettings.min_p_enabled} />
                        <Slider min={0} max={1} step={0.01} value={loadSettings.min_p ?? 0.05} onChange={(value) => setLoadSettings({ ...loadSettings, min_p: value })} disabled={loadControlsDisabled || !loadSettings.min_p_enabled} />
                      </LoadSettingsSection>
                      <Button className="loadSettingsAction" onClick={applySelectedModelSettings} disabled={!selectedModel || modelLoading || (selectedIsLoaded ? !settingsChanged : !selectedIsLoadable)} loading={modelLoading}>{selectedIsLoaded ? 'Apply settings' : 'Load model'}</Button>
                    </Stack>
                  </Card>
                </Stack>
              )}
            </Group>
          </Tabs.Panel>
        </Tabs>

      {/* ── Load Model modal ── */}
      <Modal opened={loadModelOpen} onClose={() => { setLoadModelOpen(false); setLoadModelSearch(''); }} title="Load Model" size="md">
        <Stack gap="sm">
          <TextInput
            placeholder="Type to filter models..."
            value={loadModelSearch}
            onChange={e => setLoadModelSearch(e.currentTarget.value)}
            autoFocus
            rightSection={loadModelSearch ? <ActionIcon variant="subtle" size="sm" onClick={() => setLoadModelSearch('')}><Bi name="x-lg" /></ActionIcon> : null}
          />
          {loadableModels.length === 0 ? (
            <EmptyState title="No models available" description="Go to the Models tab to import or download models." compact />
          ) : (
            <div className="loadModelPickerList">
              {filteredPickerModels.length === 0 ? (
                <Text c="dimmed" size="sm" ta="center" py="md">No models match your search.</Text>
              ) : filteredPickerModels.map(model => {
                const isLoaded = loadedBaseIds.has(model.id);
                return (
                  <button key={model.id} type="button" className="loadModelPickerItem" onClick={() => void loadSpecificModel(model)} disabled={modelLoading}>
                    <div className="loadModelPickerInfo">
                      <Text fw={600} size="sm">{model.name}</Text>
                      <Group gap="xs" mt={2}>
                        <ModelTypeBadge model={model} />
                        {isLoaded && <Badge color="green" variant="light" size="xs">loaded</Badge>}
                      </Group>
                    </div>
                    <Group gap="sm" style={{ flexShrink: 0 }}>
                      <Text size="xs" c="dimmed">{formatBytes(model.size_bytes)}</Text>
                      <Badge variant="outline" size="sm" color="blue">{model.format ?? 'GGUF'}</Badge>
                    </Group>
                  </button>
                );
              })}
            </div>
          )}
        </Stack>
      </Modal>

      {/* ── Import Model modal ── */}
      <Modal opened={importOpen} onClose={() => setImportOpen(false)} title="Import Model" size="95vw" classNames={{ content: 'importModelModalContent', header: 'importModelModalHeader', title: 'importModelModalTitle', body: 'importModelModalBody' }}>
        <Tabs defaultValue="download">
          <Tabs.List mb="md">
            <Tabs.Tab value="download">↓ Download from Hugging Face</Tabs.Tab>
            <Tabs.Tab value="import">Import Local File</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="import">
            <Stack>
              <Text c="dimmed" size="sm">Provide the full path to a GGUF file on this machine. LLMeter will copy it into the managed model store.</Text>
              <Text c="dimmed" size="xs">Store: <Text span className="mono">{modelStore.data ?? 'Loading...'}</Text></Text>
              <Group gap="sm">
                <TextInput placeholder="/models/example.gguf" value={importPath} onChange={e => setImportPath(e.currentTarget.value)} style={{ flex: 1 }} />
                <Button onClick={importModel} disabled={!importPath.trim()}>Import</Button>
              </Group>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="download">
          <Card withBorder className="hfModelBrowser">
            <div className="hfBrowserGrid">
              {/* ── Sidebar ── */}
              <div className="hfBrowserSidebar">
                <div className="hfSidebarSearch">
                  <TextInput
                    placeholder="Search models..."
                    value={hfSearch}
                    onChange={e => setHfSearch(e.currentTarget.value)}
                    rightSection={hfSearch ? <button className="hfSearchClear" onClick={() => setHfSearch('')} type="button"><Bi name="x-lg" /></button> : null}
                  />
                </div>
                <div className="hfFilterRow">
                  <Text size="xs" c="dimmed" fw={600}>{filteredHfModels.length} models</Text>
                  <Select
                    size="xs"
                    data={[
                      { value: 'all', label: 'GGUF, MLX' },
                      { value: 'gguf', label: 'GGUF' },
                      { value: 'transformer', label: 'Transformer' },
                    ]}
                    value={hfFormatFilter}
                    onChange={(value) => { setSelectedHfModelId(null); setHfFormatFilter((value ?? 'all') as HfFormatFilter); }}
                    allowDeselect={false}
                    className="hfFilterSelect"
                  />
                  <Select
                    size="xs"
                    data={[
                      { value: 'downloads', label: 'Most Downloaded' },
                      { value: 'likes', label: 'Most Liked' },
                      { value: 'lastModified', label: 'Recently Updated' },
                      { value: '', label: 'Best Match' },
                    ]}
                    value={hfSort}
                    onChange={(value) => setHfSort(value ?? 'downloads')}
                    allowDeselect={false}
                    className="hfFilterSelect"
                  />
                  <ActionIcon variant="subtle" size="sm" onClick={() => loadHuggingFaceModels(hfSearch, hfFormatFilter, hfSort)} loading={hfLoading} title="Refresh"><Bi name="arrow-clockwise" /></ActionIcon>
                </div>
                {hfError ? <ErrorCard message={hfError} /> : null}
                <div className="hfModelList">
                  {hfLoading && hfModels.length === 0 ? <Text c="dimmed" size="sm" p="sm">Loading Hugging Face models...</Text> : null}
                  {!hfLoading && hfModels.length === 0 && !hfError ? <Text c="dimmed" size="sm" p="sm">No models found.</Text> : null}
                  {!hfLoading && hfModels.length > 0 && filteredHfModels.length === 0 && !hfError ? <Text c="dimmed" size="sm" p="sm">No {hfFormatFilter} models in results.</Text> : null}
                  {filteredHfModels.map(model => {
                    const modelId = huggingFaceModelId(model);
                    const caps = hfCapabilities(model);
                    return (
                      <button key={modelId} type="button" className={modelId === selectedHfModelIdValue ? 'hfModelListItem active' : 'hfModelListItem'} onClick={() => { setSelectedHfModelId(modelId); setSelectedHfFileKey(null); }}>
                        <div className="hfModelAvatar">{hfModelInitial(modelId)}</div>
                        <div className="hfModelListText">
                          <div className="hfModelListName">
                            <strong>{hfShortModelName(modelId)}</strong>
                            {(model.author?.includes('google') || model.author?.includes('meta') || model.author?.includes('microsoft') || model.author?.includes('mistralai')) && <span className="hfVerifiedBadge" title="Verified publisher">✓</span>}
                          </div>
                          <span>{hfModelSubtitle(model)}</span>
                        </div>
                        <div className="hfModelCapIcons">
                          {caps.includes('vision') && <span className="hfCapIcon hfCapVision" title="Vision">◉</span>}
                          {caps.includes('tool-use') && <span className="hfCapIcon hfCapTool" title="Tool Use">⚙</span>}
                          {caps.includes('reasoning') && <span className="hfCapIcon hfCapReason" title="Reasoning">ℹ</span>}
                        </div>
                        <small>{hfLastUpdated(model)}</small>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── Detail panel ── */}
              <Stack gap="md" className="hfBrowserDetail">
                {selectedHfModel ? (() => {
                  const caps = hfCapabilities(selectedHfModel);
                  const activeFile = activeHfFile;
                  const activeDownloadFiles = activeFile?.files.map(part => ({ url: huggingFaceResolveUrl(selectedHfModelIdValue, part.name), name: part.name })) ?? [];
                  const activeDownloadId = activeDownloadFiles.map(p => p.url).join('|');
                  const activeDownloadedModels = activeFile?.files.flatMap(part => downloadedModelsByFile.get(fileBaseName(part.name)) ?? []) ?? [];
                  const activeIsDownloaded = Boolean(activeFile) && activeFile!.files.every(part => (downloadedModelsByFile.get(fileBaseName(part.name)) ?? []).length > 0);
                  const activeDeleteId = `delete:${Array.from(new Set(activeDownloadedModels.map(m => m.id))).join(',')}`;
                  const activeProgress = hfDownloadProgress?.download_id === activeDownloadId ? hfDownloadProgress : null;
                  const activeProgressValue = activeProgress?.total_bytes ? Math.min(100, Math.round((activeProgress.downloaded_bytes / activeProgress.total_bytes) * 1000) / 10) : null;
                  const mmprojectProgress = hfDownloadProgress?.download_id === activeDownloadId + '_mmproj' ? hfDownloadProgress : null;
                  const mmprojectProgressValue = mmprojectProgress?.total_bytes ? Math.min(100, Math.round((mmprojectProgress.downloaded_bytes / mmprojectProgress.total_bytes) * 1000) / 10) : null;
                  return (
                    <>
                      {/* Header */}
                      <div className="hfDetailHeader">
                        <Group gap="sm" wrap="nowrap" className="hfDetailTitleRow">
                          <div className="hfDetailIcon">◈</div>
                          <div className="hfDetailTitleBlock">
                            <Text className="hfDetailAuthor">{selectedHfModelIdValue.split('/')[0] ?? 'Hugging Face'}</Text>
                            <button type="button" className="hfDetailTitle" onClick={() => openHuggingFaceModel(selectedHfModelIdValue)}>{hfShortModelName(selectedHfModelIdValue)}</button>
                          </div>
                          <ActionIcon variant="subtle" title="Copy model id" onClick={() => navigator.clipboard.writeText(selectedHfModelIdValue)}><Bi name="copy" /></ActionIcon>
                        </Group>
                        <Badge color={huggingFaceLicense(selectedHfModel) === 'Unknown' ? 'gray' : 'blue'} variant="light">{huggingFaceLicense(selectedHfModel)}</Badge>
                      </div>

                      {/* Stats row */}
                      <Group gap="sm" className="hfDetailStats">
                        <span className="hfStatChip">↓ {(selectedHfModel.downloads ?? 0).toLocaleString()}</span>
                        <span className="hfStatChip">☆ {(selectedHfModel.likes ?? 0).toLocaleString()}</span>
                        <Text c="dimmed" size="xs">Last updated: {hfLastUpdated(selectedHfModel)}</Text>
                      </Group>

                      {/* Summary */}
                      <Card withBorder className="hfSummaryCard"><Text size="sm">{hfModelSummary(selectedHfModel)}</Text></Card>

                      {/* Metadata chips */}
                      <div className="hfMetaChips">
                        {hfMetadataPills(selectedHfModel).map(pill => (
                          <span key={`${pill.label}-${pill.value}`} className="hfMetaChip">
                            <span className="hfMetaChipLabel">{pill.label}</span>
                            <span className="hfMetaChipValue">{pill.value}</span>
                          </span>
                        ))}
                        <span className="hfMetaChip">
                          <span className="hfMetaChipLabel">Format</span>
                          <span className="hfMetaChipValue hfMetaChipHighlight">{selectedHfFiles.length > 0 ? 'GGUF' : 'HF'}</span>
                        </span>
                      </div>

                      {/* Capabilities */}
                      {caps.length > 0 && (
                        <Group gap="xs" align="center">
                          <Text size="xs" c="dimmed" fw={600}>Capabilities:</Text>
                          {caps.includes('vision') && <Badge color="violet" variant="light">Vision</Badge>}
                          {caps.includes('tool-use') && <Badge color="orange" variant="light">Tool Use</Badge>}
                          {caps.includes('reasoning') && <Badge color="cyan" variant="light">Reasoning</Badge>}
                        </Group>
                      )}

                      {/* Download panel */}
                      <Card withBorder className="hfDownloadPanel">
                        <Text fw={800} mb="xs">Download Options</Text>
                        {selectedHfFiles.length > 0 ? (
                          <Stack gap="sm">
                            {/* File selector — with RAM compatibility icons */}
                            <div className="hfFileOptionList">
                              {selectedHfFiles.map(f => {
                                const isActive = (activeFile?.key ?? selectedHfFiles[0]?.key) === f.key;
                                const compat = getCompatibility(f.size, systemMemory.data);
                                return (
                                  <button
                                    key={f.key}
                                    type="button"
                                    className={`hfFileOption${isActive ? ' active' : ''}`}
                                    onClick={() => setSelectedHfFileKey(f.key)}
                                  >
                                    <span className="hfFileOptionLabel">{f.label}</span>
                                    <span className="hfFileOptionMeta">
                                      {f.size ? <span className="hfFileOptionSize">{formatBytes(f.size)}</span> : null}
                                      <CompatIcon compat={compat} size={f.size} />
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            {/* Progress */}
                            {(activeProgress || mmprojectProgress) ? (
                              <Stack gap="xs">
                                {activeProgress && (
                                  <div className="hfProgressBlock">
                                    <Group justify="space-between" gap="xs">
                                      <Text size="xs" className="hfDownloadInfo">
                                        {activeProgress.status === 'done' ? 'Model downloaded' : `Downloading part ${activeProgress.part_index}/${activeProgress.part_total}`}
                                      </Text>
                                      <Text size="xs" c="dimmed">
                                        {activeProgressValue !== null ? `${activeProgressValue.toFixed(1)}%` : formatBytes(activeProgress.downloaded_bytes)}
                                      </Text>
                                    </Group>
                                    <Progress value={activeProgressValue ?? 100} size="sm" color="green" animated={activeProgress.status === 'downloading'} striped={activeProgressValue === null || activeProgress.status === 'downloading'} />
                                  </div>
                                )}
                                {mmprojectProgress && (
                                  <div className="hfProgressBlock">
                                    <Group justify="space-between" gap="xs">
                                      <Text size="xs" className="hfDownloadInfo">
                                        {mmprojectProgress.status === 'done' ? 'mmproj downloaded' : 'Downloading mmproj…'}
                                      </Text>
                                      <Text size="xs" c="dimmed">
                                        {mmprojectProgressValue !== null ? `${mmprojectProgressValue.toFixed(1)}%` : formatBytes(mmprojectProgress.downloaded_bytes)}
                                      </Text>
                                    </Group>
                                    <Progress value={mmprojectProgressValue ?? 100} size="sm" color="violet" animated={mmprojectProgress.status === 'downloading'} striped={mmprojectProgressValue === null || mmprojectProgress.status === 'downloading'} />
                                  </div>
                                )}
                              </Stack>
                            ) : null}
                            {/* Vision model note */}
                            {!activeIsDownloaded && !hfDownloading && caps.includes('vision') && (
                              <Text size="xs" c="dimmed">Vision model: mmproj projector will be downloaded automatically.</Text>
                            )}
                            {/* Download / Delete row */}
                            <Stack gap="xs">
                              {activeFile && activeFile.files.length > 1 && <Text size="xs" c="dimmed">{activeFile.files.length} parts · split download</Text>}
                              <Group gap="xs" style={{ width: '100%' }}>
                                {activeIsDownloaded ? (
                                  <Button color="red" variant="light" size="sm" loading={hfDownloading === activeDeleteId} disabled={Boolean(hfDownloading) && hfDownloading !== activeDeleteId} onClick={() => deleteDownloadedHuggingFaceModel(activeDownloadedModels, activeFile?.label ?? '')}>Delete</Button>
                                ) : null}
                                <Button
                                  color={activeIsDownloaded ? 'green' : 'blue'}
                                  variant={activeIsDownloaded ? 'light' : 'filled'}
                                  size="md"
                                  loading={hfDownloading === activeDownloadId}
                                  disabled={activeIsDownloaded || Boolean(hfDownloading) || !activeFile}
                                  onClick={() => activeFile && downloadHuggingFaceModel(activeDownloadFiles, activeFile.label, activeFile.size)}
                                  className="hfDownloadBtn"
                                  style={{ flex: 1 }}
                                >
                                  {activeIsDownloaded ? '✓ Downloaded' : `↓ Download${activeFile?.size ? `  ${formatBytes(activeFile.size)}` : ''}`}
                                </Button>
                              </Group>
                            </Stack>
                          </Stack>
                        ) : (
                          <Stack gap="sm">
                            <Text c="dimmed" size="sm">No GGUF file listed. Download weights and convert locally with llama.cpp.</Text>
                            {convertProgress ? (
                              <div className="hfProgressBlock">
                                <Group justify="space-between" gap="xs">
                                  <Text size="xs" className="hfDownloadInfo">
                                    {convertProgress.status === 'converting' ? 'Converting to GGUF' : `Downloading file ${convertProgress.part_index}/${convertProgress.part_total}`}
                                  </Text>
                                  <Text size="xs" c="dimmed">
                                    {convertProgressValue !== null ? `${convertProgressValue.toFixed(1)}%` : formatBytes(convertProgress.downloaded_bytes)}
                                  </Text>
                                </Group>
                                <Progress value={convertProgressValue ?? 100} size="sm" color={convertProgress.status === 'converting' ? 'blue' : 'green'} animated striped />
                              </div>
                            ) : null}
                            <Button color="green" loading={hfDownloading === convertDownloadId} disabled={Boolean(hfDownloading) || selectedHfConvertibleFiles.length === 0} onClick={() => selectedHfModel && convertHuggingFaceModel(selectedHfModel)}>
                              Download + Convert to GGUF
                            </Button>
                            <Text c="dimmed" size="xs">Requires convert_hf_to_gguf.py from llama.cpp in Server Settings. Default output type: q8_0.</Text>
                          </Stack>
                        )}
                      </Card>

                      {/* Tags */}
                      {(selectedHfModel.tags ?? []).length > 0 && (
                        <Card withBorder className="hfReadmeCard">
                          <Text fw={700} size="xs" c="dimmed" mb="xs">TAGS</Text>
                          <Group gap="xs">
                            {(selectedHfModel.tags ?? []).slice(0, 16).map(tag => (
                              <span key={tag} className="hfTagPill">{tag}</span>
                            ))}
                          </Group>
                        </Card>
                      )}
                    </>
                  );
                })() : <Text c="dimmed">Select a model from the list.</Text>}
              </Stack>
            </div>
          </Card>
          </Tabs.Panel>
        </Tabs>
      </Modal>

      {/* ── Server Settings modal ── */}
      <Modal opened={settingsOpen} onClose={() => setSettingsOpen(false)} title="Server Settings" size="lg" classNames={{ content: 'settingsModalContent', header: 'settingsModalHeader', title: 'settingsModalTitle', body: 'settingsModalBody' }}>
        <SettingsPanel currentUser={currentUser} onSaved={reloadServerStatus} />
      </Modal>

      <Modal opened={Boolean(modelToDelete)} onClose={() => deletingModelId === null && setModelToDelete(null)} title="Delete model" centered>
        <Stack>
          <Text>
            Delete <Text span fw={800}>{modelToDelete?.name}</Text>? This will eject the model if it is loaded and remove it from LLMeter.
          </Text>
          <Text size="sm" c="dimmed">If the model file is inside the LLMeter model folder, the file will also be deleted. External imported files are left in place.</Text>
          <Group justify="end">
            <Button variant="default" disabled={deletingModelId !== null} onClick={() => setModelToDelete(null)}>Cancel</Button>
            <Button color="red" variant="light" loading={deletingModelId !== null} onClick={() => void confirmDeleteModel()}>Delete model</Button>
          </Group>
        </Stack>
      </Modal>

      {/* ── mcp.json modal ── */}
      <Modal opened={mcpOpen} onClose={() => setMcpOpen(false)} title="mcp.json" size="md">
        <Stack>
          <Text c="dimmed" size="sm">Add this to your Claude Desktop mcp.json to connect to the local server.</Text>
          <Textarea readOnly value={mcpConfig} autosize minRows={6} className="mono" />
          <Button onClick={() => navigator.clipboard.writeText(mcpConfig)}>Copy to clipboard</Button>
        </Stack>
      </Modal>

      {/* ── Downloads panel ── */}
      {downloadsOpen && (
        <div className="downloadsPanel">
          {/* Header */}
          <div className="downloadsPanelHeader">
            <Text fw={700} size="sm">Downloads</Text>
            <Group gap="xs">
              <ActionIcon variant="subtle" size="sm" title="Close" onClick={() => setDownloadsOpen(false)}><Bi name="x-lg" /></ActionIcon>
            </Group>
          </div>
          {/* Filter */}
          <div className="downloadsPanelFilter">
            <TextInput
              size="xs"
              placeholder="Filter downloads..."
              value={downloadsFilter}
              onChange={e => setDownloadsFilter(e.currentTarget.value)}
              rightSection={downloadsFilter ? <ActionIcon variant="subtle" size="xs" onClick={() => setDownloadsFilter('')}><Bi name="x" /></ActionIcon> : null}
            />
          </div>
          {/* List */}
          <div className="downloadsPanelList">
            {(() => {
              const all = Array.from(downloads.values()).filter(d => !downloadsFilter || d.label.toLowerCase().includes(downloadsFilter.toLowerCase())).reverse();
              const active = all.filter(d => d.status === 'downloading');
              const completed = all.filter(d => d.status !== 'downloading');
              if (all.length === 0) return (
                <div className="downloadsPanelEmpty">
                  <i className="bi bi-cloud-arrow-down" style={{ fontSize: 28, opacity: 0.3 }} />
                  <Text size="sm" c="dimmed">No downloads yet</Text>
                </div>
              );
              return (
                <>
                  {active.length > 0 && (
                    <>
                      <div className="downloadsPanelSection">Downloading</div>
                      {active.map(d => <DownloadItem key={d.id} entry={d} onCancel={() => void cancelDownload(d.id)} />)}
                    </>
                  )}
                  {completed.length > 0 && (
                    <>
                      <div className="downloadsPanelSection">
                        <span>Completed</span>
                        <button className="downloadsClearBtn" onClick={() => setDownloads(prev => { const next = new Map(prev); for (const [k, v] of next) if (v.status !== 'downloading') next.delete(k); return next; })}>Clear</button>
                      </div>
                      {completed.map(d => <DownloadItem key={d.id} entry={d} />)}
                    </>
                  )}
                </>
              );
            })()}
          </div>
          {/* Footer */}
          <button className="downloadsPanelFooter" onClick={async () => { try { await invoke('open_external_url', { url: `file://${modelStore.data ?? ''}` }); } catch {} }}>
            Open model folder <Bi name="arrow-up-right" />
          </button>
        </div>
      )}

      {/* Floating downloads button */}
      {downloads.size > 0 && !downloadsOpen && (
        <button className="downloadsFloatBtn" onClick={() => setDownloadsOpen(true)} title="Downloads">
          {Array.from(downloads.values()).some(d => d.status === 'downloading') ? (
            <span className="downloadsFloatSpinner"><Bi name="cloud-arrow-down" /></span>
          ) : (
            <Bi name="cloud-arrow-down" />
          )}
          {Array.from(downloads.values()).filter(d => d.status === 'downloading').length > 0 && (
            <span className="downloadsFloatBadge">{Array.from(downloads.values()).filter(d => d.status === 'downloading').length}</span>
          )}
        </button>
      )}
    </Stack>
  );
}

function DownloadItem({ entry, onCancel }: { entry: DownloadEntry; onCancel?: () => void }) {
  const pct = entry.totalBytes && entry.totalBytes > 0 ? Math.min(100, Math.round((entry.downloadedBytes / entry.totalBytes) * 100)) : null;
  const statusColor = entry.status === 'done' ? '#4ade80' : entry.status === 'error' ? '#f87171' : entry.status === 'cancelled' ? '#6b7280' : '#60a5fa';
  return (
    <div className="downloadItem">
      <div className="downloadItemIcon">
        <i className={`bi bi-${entry.status === 'done' ? 'check-circle-fill' : entry.status === 'error' ? 'x-circle-fill' : entry.status === 'cancelled' ? 'slash-circle' : 'cloud-arrow-down'}`} style={{ color: statusColor, fontSize: 18 }} />
      </div>
      <div className="downloadItemBody">
        <Text size="xs" fw={600} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.label}</Text>
        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            {entry.status === 'downloading'
              ? `${formatBytes(entry.downloadedBytes)}${entry.totalBytes ? ` / ${formatBytes(entry.totalBytes)}` : ''}${entry.partTotal > 1 ? ` · part ${entry.partIndex}/${entry.partTotal}` : ''}`
              : entry.status === 'done' ? (entry.sizeBytes ? formatBytes(entry.sizeBytes) : 'Done')
              : entry.status === 'cancelled' ? 'Cancelled'
              : 'Failed'}
          </Text>
        </Group>
        {entry.status === 'downloading' && (
          <Progress value={pct ?? 100} size="xs" color="blue" animated={pct === null} striped={pct === null} mt={3} />
        )}
      </div>
      {entry.status === 'downloading' && onCancel && (
        <button className="downloadItemCancel" onClick={onCancel} title="Cancel download">
          <Bi name="x-lg" />
        </button>
      )}
    </div>
  );
}
