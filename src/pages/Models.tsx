import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Progress,
  Select,
  Slider,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
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
  ServerStatus,
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

export function ModelsPage({ currentUser, serverStatus, setServerStatus, reloadServerStatus }: { currentUser: UserAccount; serverStatus: ServerStatus | null; setServerStatus: React.Dispatch<React.SetStateAction<ServerStatus | null>>; reloadServerStatus: () => Promise<void> }) {
  const isAdmin = currentUser.role === 'admin';
  const { data, error, reload } = useAsyncData<ModelRecord[]>(() => invoke('list_models'), []);
  const loadedStatus = useAsyncData<LoadedModelStatus[]>(() => invoke('loaded_model_status'), []);
  const modelStore = useAsyncData<string>(() => invoke('get_model_store_dir'), []);
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
  const [refreshingModelTypeId, setRefreshingModelTypeId] = useState<number | null>(null);
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

  const downloadHuggingFaceModel = async (files: Array<{ url: string; name: string }>, label: string) => {
    setMessage(null);
    setHfError(null);
    const downloadId = files.map(file => file.url).join('|');
    setHfDownloading(downloadId);
    setHfDownloadProgress(null);
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
      setMessage(`Downloaded ${label} into the model folder.`);
    } catch (err) {
      setHfError(String(err));
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
      setMessage(`Downloaded and converted ${modelId} to GGUF.`);
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

  const refreshModelType = async (event: React.MouseEvent, model: ModelRecord) => {
    event.preventDefault();
    event.stopPropagation();
    setMessage(null);
    setRefreshingModelTypeId(model.id);
    try {
      await invoke('refresh_model_type', { modelId: model.id, requesterRole: currentUser.role });
      await reload();
      setMessage(`Updated type metadata for ${model.name}.`);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setRefreshingModelTypeId(null);
    }
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

  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      {/* ── Main column ── */}
      <Stack style={{ flex: 1, minWidth: 0 }}>
        <Header
          title="Server"
          subtitle="Control the local API server, load models into RAM, and manage the model store."
          onRefresh={refresh}
        />
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
                {/* <Button size="sm" variant="default" onClick={() => setMcpOpen(true)}>📄 mcp.json</Button> */}
              </Group>
              <Group gap="sm">
                <Text c="dimmed" size="sm">{isRunning ? `Running on ${host}:${port}` : 'API server stopped'}</Text>
                <Button size="sm" variant="default" onClick={() => setSettingsOpen(true)}>Settings</Button>
              </Group>
            </Group>
          </Card>
        )}

        {message ? <StatusCard message={message} /> : null}
        {error || runtimeError ? <ErrorCard message={error ?? runtimeError ?? ''} /> : null}

        <Title order={3}>Loaded Models</Title>
        {loadedModels.length > 0 ? (
          <Stack gap="sm">
            {loadedModels.map((loadedModel) => {
              const status = loadedByName.get(loadedModel.name);
              const selected = selectedLoadedName === loadedModel.name;
              return <Card key={loadedModel.name} withBorder p={0} className={selected ? 'loadedModelCard selected' : 'loadedModelCard'} onClick={() => { setSelectedModelId(loadedModel.id); setSelectedLoadedName(loadedModel.name); }}>
                <Group justify="space-between" px="md" pt="md" pb="xs">
                  <Badge color="green" variant="light" size="lg">READY</Badge>
                  {status?.port ? <Text c="dimmed" size="sm">internal :{status.port}</Text> : null}
                </Group>
                <Group justify="space-between" px="md" pb="md">
                  <Group gap="xs">
                    <Badge variant="default" radius="sm">llm</Badge>
                    <Text className="mono" c="teal" fw={600}>{loadedModel.name}</Text>
                    <ActionIcon variant="subtle" size="sm" title="Copy model name" onClick={(event) => { event.stopPropagation(); navigator.clipboard.writeText(loadedModel.name); }}><Bi name="copy" /></ActionIcon>
                  </Group>
                  <Group gap="lg">
                    <Text size="sm" c="dimmed">Size <Text span fw={700} c="white">{formatBytes(loadedModel.size_bytes)}</Text></Text>
                    {status?.context_length ? <Text size="sm" c="dimmed">Context <Text span fw={700} c="white">{status.context_length.toLocaleString()}</Text></Text> : null}
                    {status?.n_threads ? <Text size="sm" c="dimmed">Threads <Text span fw={700} c="white">{status.n_threads}</Text></Text> : null}
                    {isAdmin && <Button size="xs" color="red" variant="light" leftSection={<Bi name="eject" />} onClick={(event) => { event.stopPropagation(); void ejectModel(loadedModel.name); }}>Eject</Button>}
                    {isAdmin && <Button size="xs" color="red" variant="light" loading={deletingModelId === loadedModel.id} disabled={deletingModelId !== null && deletingModelId !== loadedModel.id} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => requestDeleteModel(event, loadedModel)}>Delete</Button>}
                  </Group>
                </Group>
              </Card>;
            })}
          </Stack>
        ) : (
          <EmptyState
            title="No model loaded"
            description={isAdmin ? 'Select an available model below, review Load Settings, then load it into RAM. The API server can stay stopped while you prepare models.' : 'No model is loaded yet. Ask an admin to load one before chatting.'}
          />
        )}

        <Group justify="space-between" align="center">
          <Title order={3}>Available Models</Title>
          <TableControls shown={modelsShown} onShownChange={(value) => { setModelsShown(value); setModelsPage(0); }} page={modelsPageData.page} totalPages={modelsPageData.totalPages} onPageChange={setModelsPage}>
            {isAdmin && <Button size="xs" variant="default" onClick={() => setImportOpen(true)}>↓ Import Model</Button>}
          </TableControls>
        </Group>
        <Card withBorder>
          <Table.ScrollContainer minWidth={600}>
            <Table highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>Format</Table.Th><Table.Th>Type / Inputs</Table.Th><Table.Th>Status</Table.Th><Table.Th>Size</Table.Th>{isAdmin ? <Table.Th>Action</Table.Th> : null}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {visibleModels.map(model => (
                  <Table.Tr key={model.id} className={selectedModel?.id === model.id && !selectedLoadedName ? 'selectableModelRow selected' : 'selectableModelRow'} onClick={() => { setSelectedModelId(model.id); setSelectedLoadedName(null); }}>
                    <Table.Td>{model.name}</Table.Td>
                    <Table.Td>{model.format}</Table.Td>
                    <Table.Td><ModelTypeBadge model={model} /></Table.Td>
                    <Table.Td><Badge color={loadedBaseIds.has(model.id) ? 'green' : 'gray'} variant={loadedBaseIds.has(model.id) ? 'light' : 'outline'}>{loadedBaseIds.has(model.id) ? 'loaded' : 'unloaded'}</Badge></Table.Td>
                    <Table.Td>{formatBytes(model.size_bytes)}</Table.Td>
                    {isAdmin ? <Table.Td><Group gap="xs" wrap="nowrap">{model.hf_repo ? <Button size="xs" variant="default" loading={refreshingModelTypeId === model.id} disabled={refreshingModelTypeId !== null && refreshingModelTypeId !== model.id} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => void refreshModelType(event, model)}>Refresh type</Button> : null}<Button size="xs" color="red" variant="light" loading={deletingModelId === model.id} disabled={deletingModelId !== null && deletingModelId !== model.id} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => requestDeleteModel(event, model)}>Delete</Button></Group></Table.Td> : null}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {(data?.length ?? 0) === 0 ? <EmptyState title="No imported models" description={isAdmin ? 'Import a local GGUF file or download a compatible model from Hugging Face to get started.' : 'No models are available yet. Ask an admin to import or download one.'} compact /> : null}
        </Card>

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

      {/* ── Right sidebar ── */}
      {isAdmin && (
        <Stack w={320} style={{ flexShrink: 0, position: 'sticky', top: 16 }}>
          <Card withBorder p={0} className="loadSettingsCard">
            <Stack gap="md">
              <div className="loadSettingsIntro">
                <Text fw={700} size="sm">Load Settings</Text>
                {selectedModel ? <Text size="xs" c="dimmed">{selectedIsLoaded ? 'Editing' : 'Ready to load'} <Text span c="teal" fw={700}>{selectedModel.name}</Text>. {selectedIsLoaded ? 'Applying changes ejects and reloads this model.' : 'Choose settings first, then load it.'}</Text> : <Text size="xs" c="dimmed">Select a model to configure it before loading.</Text>}
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

      {/* ── Import Model modal ── */}
      <Modal opened={importOpen} onClose={() => setImportOpen(false)} title="Import Model" size="95vw" classNames={{ content: 'importModelModalContent', header: 'importModelModalHeader', title: 'importModelModalTitle', body: 'importModelModalBody' }}>
        <Stack>
          <Text c="dimmed" size="sm">Provide the full path to a GGUF file on this machine. LLMeter will copy it into the managed model store.</Text>
          <Text c="dimmed" size="xs">Store: <Text span className="mono">{modelStore.data ?? 'Loading...'}</Text></Text>
          <Group gap="sm">
            <TextInput placeholder="/models/example.gguf" value={importPath} onChange={e => setImportPath(e.currentTarget.value)} style={{ flex: 1 }} />
            <Button onClick={importModel} disabled={!importPath.trim()}>Import</Button>
          </Group>
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
                            {/* File selector */}
                            <Select
                              data={selectedHfFiles.map(f => ({ value: f.key, label: f.label + (f.size ? `  ·  ${formatBytes(f.size)}` : '') }))}
                              value={activeFile?.key ?? selectedHfFiles[0]?.key ?? null}
                              onChange={(key) => setSelectedHfFileKey(key)}
                              allowDeselect={false}
                              className="hfFileSelect"
                            />
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
                            <Group justify="space-between" align="center">
                              {activeFile && activeFile.files.length > 1 && <Text size="xs" c="dimmed">{activeFile.files.length} parts</Text>}
                              <Group gap="xs" ml="auto">
                                {activeIsDownloaded ? (
                                  <Button color="red" variant="light" size="sm" loading={hfDownloading === activeDeleteId} disabled={Boolean(hfDownloading) && hfDownloading !== activeDeleteId} onClick={() => deleteDownloadedHuggingFaceModel(activeDownloadedModels, activeFile?.label ?? '')}>Delete</Button>
                                ) : null}
                                <Button
                                  color={activeIsDownloaded ? 'green' : 'blue'}
                                  variant={activeIsDownloaded ? 'light' : 'filled'}
                                  size="md"
                                  loading={hfDownloading === activeDownloadId}
                                  disabled={activeIsDownloaded || Boolean(hfDownloading) || !activeFile}
                                  onClick={() => activeFile && downloadHuggingFaceModel(activeDownloadFiles, activeFile.label)}
                                  className="hfDownloadBtn"
                                >
                                  {activeIsDownloaded ? '✓ Downloaded' : `↓ Download${activeFile?.size ? `  ${formatBytes(activeFile.size)}` : ''}`}
                                </Button>
                              </Group>
                            </Group>
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
        </Stack>
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
    </Group>
  );
}
