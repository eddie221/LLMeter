import { invoke } from '@tauri-apps/api/core';
import { listen, TauriEvent } from '@tauri-apps/api/event';
import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ChatGroup,
  InferenceParams,
  LoadedModelStatus,
  SettingsRecord,
  UserAccount,
} from '../types';
import { ANTHROPIC_MODELS, MAX_CHAT_ATTACHMENT_BYTES } from '../constants';
import { Bi } from '../components/Bi';
import { MarkdownView } from '../components/Markdown';
import { ErrorCard } from '../components/common';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatBytes, downloadTextFile } from '../lib/format';

export type ChatMsgAttachment = { name: string; mime: string; size: number; kind: 'text' | 'image' | 'binary'; content: string };
export type ChatMsgMeta = { model?: string; output_tokens?: number; input_tokens?: number; time_ms?: number; finish_reason?: string };
export type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string; attachments?: ChatMsgAttachment[]; timestamp?: number; meta?: ChatMsgMeta };
export type ChatSession = { id: string; title: string; model: string; systemPrompt: string; messages: ChatMsg[]; createdAt: number; updatedAt: number };
export type ChatAttachment = { id: string; name: string; mime: string; size: number; kind: 'text' | 'image' | 'binary'; content: string };
export type ChatAttachmentPayload = Omit<ChatAttachment, 'id'>;
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
export type ChatRequestMessage = { role: ChatMsg['role']; content: string | ChatContentPart[] };
export type ChatSortBy = 'created' | 'updated' | 'tokens';
export type ChatSortDirection = 'asc' | 'desc';

const VISION_PIPELINE_TAGS = new Set(['image-text-to-text', 'visual-question-answering', 'image-to-text']);
const ANTHROPIC_MODEL_VALUES = new Set(ANTHROPIC_MODELS.map(m => m.value));

export function newChatSession(model = ''): ChatSession {
  const now = Date.now();
  return { id: `chat_${now}_${Math.random().toString(16).slice(2)}`, title: 'New chat', model, systemPrompt: '', messages: [], createdAt: now, updatedAt: now };
}

export async function persistChatSession(userId: number, groupId: string, session: ChatSession) {
  await invoke('save_chat_session', { userId, groupId, session });
}

export function chatTitleFromMessage(content: string) {
  const oneLine = content.trim().replace(/\s+/g, ' ');
  return oneLine.length > 42 ? `${oneLine.slice(0, 42)}...` : oneLine || 'New chat';
}

export function safeDownloadName(value: string, fallback: string) {
  const clean = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}

export function chatSessionMarkdown(session: ChatSession) {
  const lines = [`# ${session.title || 'Untitled chat'}`, '', `Model: ${session.model || 'Not selected'}`, `Created: ${new Date(session.createdAt).toISOString()}`, `Updated: ${new Date(session.updatedAt).toISOString()}`, ''];
  for (const message of session.messages) {
    lines.push(`## ${message.role}${message.timestamp ? ` - ${new Date(message.timestamp).toISOString()}` : ''}`, '');
    if (message.attachments?.length) {
      lines.push(`Attachments: ${message.attachments.map(attachment => `${attachment.name} (${attachment.kind}, ${formatBytes(attachment.size)})`).join(', ')}`, '');
    }
    lines.push(message.content || '(empty)', '');
  }
  return lines.join('\n');
}

export function formatChatTime(timestamp?: number) {
  if (!timestamp) return '';
  const value = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function modelSupportsImages(modelName: string, statuses: LoadedModelStatus[]): boolean {
  if (ANTHROPIC_MODEL_VALUES.has(modelName)) return true;
  const status = statuses.find(s => s.model_name === modelName);
  if (!status) return false;
  return Boolean(status.mmproj_path) || VISION_PIPELINE_TAGS.has(status.model_type ?? '');
}

export function isTextLikeFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type.startsWith('text/')
    || /\.(md|txt|json|csv|tsv|xml|yaml|yml|toml|rs|ts|tsx|js|jsx|py|html|css|sql|sh|zsh|log)$/i.test(name);
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file.'));
    reader.readAsDataURL(file);
  });
}

export function pathsFromNativeDropPayload(payload: unknown): string[] {
  if (Array.isArray(payload)) return payload.filter((value): value is string => typeof value === 'string');
  if (typeof payload === 'string') return [payload];
  if (payload && typeof payload === 'object') {
    const paths = (payload as { paths?: unknown }).paths;
    if (Array.isArray(paths)) return paths.filter((value): value is string => typeof value === 'string');
  }
  return [];
}

export function attachmentContext(attachments: ChatMsgAttachment[]) {
  if (attachments.length === 0) return '';
  return [
    'Attached files for this message:',
    ...attachments.map((attachment, index) => [
      `\n[Attachment ${index + 1}: ${attachment.name}]`,
      `Type: ${attachment.mime || 'application/octet-stream'}`,
      `Size: ${formatBytes(attachment.size)}`,
      `Kind: ${attachment.kind}`,
      attachment.kind === 'text' ? 'Content:' : 'Content sent as a multimodal image/file part.',
      attachment.kind === 'text' ? attachment.content : '',
    ].filter(Boolean).join('\n')),
  ].join('\n');
}

export function chatPromptContent(input: string, attachments: ChatMsgAttachment[]): string | ChatContentPart[] {
  const imageAttachments = attachments.filter(attachment => attachment.kind === 'image' && attachment.content.startsWith('data:'));
  const textContent = [input.trim(), attachmentContext(attachments)].filter(Boolean).join('\n\n');
  if (imageAttachments.length === 0) return textContent;
  const parts: ChatContentPart[] = [];
  if (textContent.trim()) parts.push({ type: 'text', text: textContent });
  imageAttachments.forEach(attachment => {
    parts.push({ type: 'image_url', image_url: { url: attachment.content } });
  });
  return parts;
}

export function mergeChatContent(left: string | ChatContentPart[], right: string | ChatContentPart[]): string | ChatContentPart[] {
  const leftParts = Array.isArray(left) ? left : [{ type: 'text' as const, text: left }];
  const rightParts = Array.isArray(right) ? right : [{ type: 'text' as const, text: right }];
  return [...leftParts, ...rightParts];
}

export function normalizeChatRequestMessages(messages: ChatRequestMessage[]): ChatRequestMessage[] {
  const normalized: ChatRequestMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.role === 'assistant' && normalized.length === 0) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === message.role) {
      previous.content = mergeChatContent(previous.content, message.content);
    } else {
      normalized.push({ ...message });
    }
  }
  return normalized;
}

export function displayChatContent(content: string) {
  return content.replace(/data:[^\s;]+\/[^\s;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 attachment data hidden in chat view]');
}

export function ChatPage({ currentUser }: { currentUser: UserAccount }) {
  const isAdmin = currentUser.role === 'admin';
  const loadedStatus = useAsyncData<LoadedModelStatus[]>(() => invoke('loaded_model_status'), []);
  useEffect(() => {
    const id = setInterval(() => { void loadedStatus.reload(); }, 4000);
    return () => clearInterval(id);
  }, [loadedStatus.reload]);
  const settings = useAsyncData<SettingsRecord>(
    () => invoke('get_settings', { requesterRole: currentUser.role }),
    [currentUser.role],
    isAdmin,
  );

  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState('');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sidebarSessionsByGroup, setSidebarSessionsByGroup] = useState<Record<string, ChatSession[]>>({});
  const [activeSessionId, setActiveSessionId] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [chatSortBy, setChatSortBy] = useState<ChatSortBy>('updated');
  const [chatSortDirection, setChatSortDirection] = useState<ChatSortDirection>('desc');
  const [showChatTokenCount, setShowChatTokenCount] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameSessionGroupId, setRenameSessionGroupId] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupToDelete, setGroupToDelete] = useState<ChatGroup | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [inferParams, setInferParams] = useState<InferenceParams>({});
  const [thinkEnabled, setThinkEnabled] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeSession = sessions.find(session => session.id === activeSessionId) ?? sessions[0];
  const model = selectedModel;
  const systemPrompt = activeSession?.systemPrompt ?? '';

  // Refs so the native-drop useEffect always reads current values without re-registering listeners
  const modelRef = useRef(model);
  const loadedStatusDataRef = useRef<LoadedModelStatus[]>([]);
  modelRef.current = model;
  loadedStatusDataRef.current = loadedStatus.data ?? [];
  const messages = activeSession?.messages ?? [];

  const localModels = (loadedStatus.data ?? [])
    .filter(s => s.loaded && s.model_name)
    .map(s => ({ value: s.model_name!, label: s.model_name! }));
  const hasAnthropicKey = isAdmin && Boolean(settings.data?.anthropic_api_key);
  const modelOptions = [...localModels, ...(hasAnthropicKey ? ANTHROPIC_MODELS : [])];

  const activeLoadedStatus = loadedStatus.data?.find(s => s.model_name === model);
  const contextWindow = activeLoadedStatus?.context_length ?? 4096;
  const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  const visionCapable = modelSupportsImages(model, loadedStatus.data ?? []);
  const thinkingCapable = model.startsWith('claude-') || Boolean(activeLoadedStatus?.model_type?.includes('reasoning'));
  const sessionAgeLabel = (session: ChatSession) => {
    const diff = Math.max(0, Date.now() - session.updatedAt);
    const day = 24 * 60 * 60 * 1000;
    if (diff < day) return 'now';
    if (diff < day * 7) return `${Math.max(1, Math.floor(diff / day))}d`;
    return `${Math.max(1, Math.floor(diff / (day * 7)))}w`;
  };
  const sessionTokenEstimate = (session: ChatSession) => session.messages.reduce((sum, message) => {
    const attachmentText = message.attachments?.map(attachment => attachment.kind === 'text' ? attachment.content : attachment.name).join(' ') ?? '';
    return sum + Math.ceil(`${message.content} ${attachmentText}`.length / 4);
  }, 0);
  const visibleSidebarSessions = (items: ChatSession[]) => {
    const needle = chatSearch.trim().toLowerCase();
    const filtered = needle
      ? items.filter(session => session.title.toLowerCase().includes(needle))
      : items;
    return [...filtered].sort((a, b) => {
      const valueA = chatSortBy === 'created' ? a.createdAt : chatSortBy === 'updated' ? a.updatedAt : sessionTokenEstimate(a);
      const valueB = chatSortBy === 'created' ? b.createdAt : chatSortBy === 'updated' ? b.updatedAt : sessionTokenEstimate(b);
      return chatSortDirection === 'asc' ? valueA - valueB : valueB - valueA;
    });
  };
  const ungroupedSidebarSessions = visibleSidebarSessions(sidebarSessionsByGroup[''] ?? []);

  const updateActiveSession = (patch: Partial<ChatSession> | ((session: ChatSession) => Partial<ChatSession>)) => {
    const targetSessionId = activeSession?.id;
    if (!targetSessionId) return;
    setSessions(prev => prev.map(session => {
      if (session.id !== targetSessionId) return session;
      const nextPatch = typeof patch === 'function' ? patch(session) : patch;
      const next = { ...session, ...nextPatch, updatedAt: Date.now() };
      setSidebarSessionsByGroup(previous => ({
        ...previous,
        [activeGroupId]: (previous[activeGroupId] ?? prev).map(item => item.id === targetSessionId ? next : item),
      }));
      void persistChatSession(currentUser.id, activeGroupId, next).catch(err => setError(String(err)));
      return next;
    }));
  };

  const updateActiveModel = (value: string) => {
    setSelectedModel(value);
    updateActiveSession({ model: value });
  };

  const createSession = (groupId = activeGroupId) => {
    const session = newChatSession(modelOptions[0]?.value ?? '');
    setActiveGroupId(groupId);
    setSessions(prev => groupId === activeGroupId ? [session, ...prev] : [session]);
    setSidebarSessionsByGroup(prev => ({ ...prev, [groupId]: [session, ...(prev[groupId] ?? [])] }));
    setActiveSessionId(session.id);
    void persistChatSession(currentUser.id, groupId, session).catch(err => setError(String(err)));
    setInput('');
    setError(null);
  };

  const deleteSession = (id: string, groupId = activeGroupId) => {
    const session = (groupId === activeGroupId ? sessions : sidebarSessionsByGroup[groupId] ?? []).find(item => item.id === id);
    if (!session) return;
    setSessionToDelete({ ...session, _groupId: groupId } as ChatSession & { _groupId: string });
  };

  const confirmDeleteSession = () => {
    const session = sessionToDelete as (ChatSession & { _groupId?: string }) | null;
    if (!session) return;
    const groupId = session._groupId ?? activeGroupId;
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== session.id);
      if (session.id === activeSessionId) setActiveSessionId(remaining[0]?.id ?? '');
      return remaining;
    });
    setSidebarSessionsByGroup(prev => ({
      ...prev,
      [groupId]: (prev[groupId] ?? []).filter(item => item.id !== session.id),
    }));
    void invoke('delete_chat_session', { userId: currentUser.id, groupId, sessionId: session.id }).catch(err => setError(String(err)));
    setSessionToDelete(null);
    setError(null);
  };

  const duplicateSession = (session: ChatSession, groupId: string) => {
    const now = Date.now();
    const duplicate: ChatSession = {
      ...session,
      id: `chat_${now}_${Math.random().toString(16).slice(2)}`,
      title: `${session.title || 'New chat'} Copy`,
      createdAt: now,
      updatedAt: now,
      messages: session.messages.map(message => ({
        ...message,
        attachments: message.attachments?.map(attachment => ({ ...attachment })),
        meta: message.meta ? { ...message.meta } : undefined,
      })),
    };
    setActiveGroupId(groupId);
    setSessions(prev => groupId === activeGroupId ? [duplicate, ...prev] : [duplicate, ...(sidebarSessionsByGroup[groupId] ?? [])]);
    setSidebarSessionsByGroup(prev => ({ ...prev, [groupId]: [duplicate, ...(prev[groupId] ?? [])] }));
    setActiveSessionId(duplicate.id);
    void persistChatSession(currentUser.id, groupId, duplicate).catch(err => setError(String(err)));
  };

  const exportSession = (session: ChatSession, format: 'json' | 'markdown') => {
    const base = safeDownloadName(session.title || session.id, 'chat-session');
    if (format === 'json') {
      downloadTextFile(`${base}.json`, JSON.stringify(session, null, 2), 'application/json');
    } else {
      downloadTextFile(`${base}.md`, chatSessionMarkdown(session), 'text/markdown');
    }
  };

  const revealSession = async (session: ChatSession, groupId: string) => {
    try {
      await invoke('reveal_chat_session', { userId: currentUser.id, groupId, sessionId: session.id });
    } catch (err) {
      setError(String(err));
    }
  };

  const openRenameSession = (session: ChatSession, groupId = activeGroupId) => {
    setRenameSessionId(session.id);
    setRenameSessionGroupId(groupId);
    setRenameTitle(session.title);
  };

  const saveSessionRename = () => {
    const title = renameTitle.trim() || 'New chat';
    const source = renameSessionGroupId === activeGroupId ? sessions : sidebarSessionsByGroup[renameSessionGroupId] ?? [];
    const renamed = source.find(session => session.id === renameSessionId);
    if (!renamed) return;
    const next = { ...renamed, title, updatedAt: Date.now() };
    if (renameSessionGroupId === activeGroupId) {
      setSessions(prev => prev.map(session => session.id === renameSessionId ? next : session));
    }
    setSidebarSessionsByGroup(previous => ({
      ...previous,
      [renameSessionGroupId]: (previous[renameSessionGroupId] ?? source).map(item => item.id === renameSessionId ? next : item),
    }));
    void persistChatSession(currentUser.id, renameSessionGroupId, next).catch(err => setError(String(err)));
    setRenameSessionId(null);
    setRenameSessionGroupId('');
    setRenameTitle('');
  };

  const selectSession = async (groupId: string, sessionId: string) => {
    setError(null);
    setInput('');
    if (groupId === activeGroupId) {
      setActiveSessionId(sessionId);
      return;
    }
    setActiveGroupId(groupId);
    setActiveSessionId(sessionId);
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name) return;
    setError(null);
    try {
      const group = await invoke<ChatGroup>('create_chat_group', { userId: currentUser.id, name });
      setGroups(prev => [...prev, group].sort((a, b) => a.name.localeCompare(b.name)));
      setSidebarSessionsByGroup(prev => ({ ...prev, [group.id]: [] }));
      setActiveGroupId(group.id);
      setSessions([]);
      setActiveSessionId('');
      setGroupName('');
      setGroupOpen(false);
    } catch (err) {
      setError(String(err));
    }
  };

  const confirmDeleteGroup = async () => {
    const group = groupToDelete;
    if (!group) return;
    setError(null);
    setDeletingGroup(true);
    try {
      await invoke('delete_chat_group', { userId: currentUser.id, groupId: group.id });
      const nextGroups = await invoke<ChatGroup[]>('list_chat_groups', { userId: currentUser.id });
      setGroups(nextGroups);
      setSidebarSessionsByGroup(prev => {
        const next = { ...prev };
        delete next[group.id];
        return next;
      });
      setGroupToDelete(null);
      if (activeGroupId === group.id) {
        const fallbackGroupId = nextGroups[0]?.id ?? '';
        setActiveGroupId(fallbackGroupId);
        setActiveSessionId('');
        setSessions([]);
        setSelectedModel('');
        setInput('');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingGroup(false);
    }
  };

  const addAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachmentError(null);
    try {
      const nextAttachments: ChatAttachment[] = [];
      for (const file of Array.from(files)) {
        if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} is too large. Max upload size is ${formatBytes(MAX_CHAT_ATTACHMENT_BYTES)} per file.`);
        }
        const kind: ChatAttachment['kind'] = file.type.startsWith('image/') ? 'image' : isTextLikeFile(file) ? 'text' : 'binary';
        if (kind === 'image' && !modelSupportsImages(model, loadedStatus.data ?? [])) {
          throw new Error(`The selected model does not support image input. Switch to a vision-capable model to attach images.`);
        }
        const content = kind === 'text' ? await file.text() : await readFileAsDataUrl(file);
        nextAttachments.push({
          id: `att_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          kind,
          content,
        });
      }
      setPendingAttachments(prev => [...prev, ...nextAttachments]);
    } catch (err) {
      setAttachmentError(String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addAttachmentPaths = useCallback(async (paths: string[], currentModel: string, statuses: LoadedModelStatus[]) => {
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    if (uniquePaths.length === 0) return;
    setAttachmentError(null);
    try {
      const nextAttachments = await Promise.all(uniquePaths.map(async (path) => {
        const attachment = await invoke<ChatAttachmentPayload>('read_chat_attachment', { path });
        if (attachment.kind === 'image' && !modelSupportsImages(currentModel, statuses)) {
          throw new Error(`The selected model does not support image input. Switch to a vision-capable model to attach images.`);
        }
        return {
          ...attachment,
          id: `att_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        };
      }));
      setPendingAttachments(prev => [...prev, ...nextAttachments]);
    } catch (err) {
      setAttachmentError(String(err));
    }
  }, []);

  const removeAttachment = (id: string) => {
    setPendingAttachments(prev => prev.filter(attachment => attachment.id !== id));
  };

  const hasDraggedFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const handleChatDragOver = (event: React.DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDraggingFiles(true);
  };
  const handleChatDragLeave = (event: React.DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
  };
  const handleChatDrop = (event: React.DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDraggingFiles(false);
    void addAttachments(event.dataTransfer.files);
  };

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const setupNativeDropListeners = async () => {
      const enter = await listen(TauriEvent.DRAG_ENTER, () => {
        if (!cancelled) setDraggingFiles(true);
      });
      const over = await listen(TauriEvent.DRAG_OVER, () => {
        if (!cancelled) setDraggingFiles(true);
      });
      const leave = await listen(TauriEvent.DRAG_LEAVE, () => {
        if (!cancelled) setDraggingFiles(false);
      });
      const drop = await listen(TauriEvent.DRAG_DROP, event => {
        if (cancelled) return;
        setDraggingFiles(false);
        void addAttachmentPaths(pathsFromNativeDropPayload(event.payload), modelRef.current, loadedStatusDataRef.current);
      });
      unlisteners.push(enter, over, leave, drop);
    };
    void setupNativeDropListeners();
    return () => {
      cancelled = true;
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [addAttachmentPaths]);

  useEffect(() => {
    let cancelled = false;
    const loadGroups = async () => {
      try {
        const nextGroups = await invoke<ChatGroup[]>('list_chat_groups', { userId: currentUser.id });
        if (cancelled) return;
        setGroups(nextGroups);
        // Keep current selection if valid; default to '' (ungrouped) if not
        setActiveGroupId(current => (current === '' || nextGroups.some(g => g.id === current)) ? current : '');
        const groupIds = ['', ...nextGroups.map(group => group.id)];
        const entries = await Promise.all(groupIds.map(async groupId => {
          const groupSessions = await invoke<ChatSession[]>('list_chat_sessions', { userId: currentUser.id, groupId });
          return [groupId, groupSessions] as const;
        }));
        if (!cancelled) setSidebarSessionsByGroup(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    };
    void loadGroups();
    return () => { cancelled = true; };
  }, [currentUser.id]);

  useEffect(() => {
    let cancelled = false;
    const loadGroupSessions = async () => {
      setSessionsLoading(true);
      try {
        const loaded = await invoke<ChatSession[]>('list_chat_sessions', { userId: currentUser.id, groupId: activeGroupId });
        if (!cancelled) {
          setSessions(loaded);
          setSidebarSessionsByGroup(prev => ({ ...prev, [activeGroupId]: loaded }));
          setActiveSessionId(current => loaded.some(session => session.id === current) ? current : loaded[0]?.id ?? '');
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };
    void loadGroupSessions();
    return () => { cancelled = true; };
  }, [currentUser.id, activeGroupId]);

  useEffect(() => {
    if (activeSession && activeSession.id !== activeSessionId) setActiveSessionId(activeSession.id);
  }, [activeSession?.id, activeSessionId]);

  useEffect(() => {
    if (modelOptions.length === 0 || !activeSession) return;
    const validSessionModel = activeSession.model && modelOptions.some(option => option.value === activeSession.model);
    const nextModel = validSessionModel ? activeSession.model : modelOptions[0].value;
    if (selectedModel !== nextModel) setSelectedModel(nextModel);
    if (activeSession.model !== nextModel) updateActiveSession({ model: nextModel });
  }, [activeSession?.id, activeSession?.model, selectedModel, modelOptions.length, modelOptions.map(option => option.value).join('|')]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadedStatus.reload(), 1500);
    return () => window.clearInterval(timer);
  }, [loadedStatus.reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if ((!input.trim() && pendingAttachments.length === 0) || !model || loading || !activeSession) return;
    setError(null);
    const sessionId = activeSession.id;
    const attachmentsAtSend = pendingAttachments;
    const userMsg: ChatMsg = {
      role: 'user',
      content: input.trim(),
      attachments: attachmentsAtSend.length > 0
        ? attachmentsAtSend.map(({ name, mime, size, kind, content }) => ({ name, mime, size, kind, content }))
        : undefined,
      timestamp: Date.now(),
    };
    const history = [...messages, userMsg];
    const groupIdAtSend = activeGroupId;
    const modelAtSend = model;
    setSessions(prev => prev.map(session => {
      if (session.id !== sessionId) return session;
      const titleSource = input.trim() || pendingAttachments.map(attachment => attachment.name).join(', ');
      const next = { ...session, title: session.messages.length === 0 ? chatTitleFromMessage(titleSource) : session.title, messages: history, updatedAt: Date.now() };
      setSidebarSessionsByGroup(previous => ({
        ...previous,
        [groupIdAtSend]: (previous[groupIdAtSend] ?? prev).map(item => item.id === sessionId ? next : item),
      }));
      void persistChatSession(currentUser.id, groupIdAtSend, next).catch(err => setError(String(err)));
      return next;
    }));
    setInput('');
    setPendingAttachments([]);
    setLoading(true);
    const requestHistory = normalizeChatRequestMessages([
      ...messages.map(msg => ({
        role: msg.role,
        // Reconstruct attachment context for LLM history (no image data, just metadata)
        content: msg.attachments?.length
          ? [msg.content, attachmentContext(msg.attachments)].filter(Boolean).join('\n\n')
          : msg.content,
      })),
      { role: 'user', content: chatPromptContent(input, attachmentsAtSend) },
    ]);
    const fullMessages: ChatRequestMessage[] = systemPrompt.trim()
      ? [{ role: 'system', content: systemPrompt.trim() }, ...requestHistory]
      : requestHistory;
    try {
      const raw = await invoke<{ text: string; output_tokens: number; input_tokens: number; time_ms: number; finish_reason?: string }>('chat', { model: modelAtSend, messages: fullMessages, params: Object.keys(inferParams).length > 0 ? inferParams : null, userId: currentUser.id });
      const assistantMsg: ChatMsg = {
        role: 'assistant',
        content: raw.text,
        timestamp: Date.now(),
        meta: { model: modelAtSend, output_tokens: raw.output_tokens, input_tokens: raw.input_tokens, time_ms: raw.time_ms, finish_reason: raw.finish_reason },
      };
      setSessions(prev => prev.map(session => {
        if (session.id !== sessionId) return session;
        const next = { ...session, messages: [...session.messages, assistantMsg], updatedAt: Date.now() };
        setSidebarSessionsByGroup(previous => ({
          ...previous,
          [groupIdAtSend]: (previous[groupIdAtSend] ?? prev).map(item => item.id === sessionId ? next : item),
        }));
        void persistChatSession(currentUser.id, groupIdAtSend, next).catch(err => setError(String(err)));
        return next;
      }));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const renderSessionRow = (session: ChatSession, groupId: string) => (
    <div key={`${groupId}:${session.id}`} className={session.id === activeSessionId && activeGroupId === groupId ? 'appChatSessionRow active' : 'appChatSessionRow'}>
      <button type="button" className="appChatSessionBtn" onClick={() => void selectSession(groupId, session.id)}>
        <span className="appChatSessionTitle">{session.title}</span>
        <span className="appChatSessionAge">{showChatTokenCount ? `${sessionTokenEstimate(session).toLocaleString()} tok` : sessionAgeLabel(session)}</span>
      </button>
      <div className="appChatSessionActions">
        <Menu position="right-start" shadow="xl" width={230} classNames={{ dropdown: 'chatSessionMenu' }}>
          <Menu.Target>
            <button type="button" className="appChatSessionAction menu" title="More actions" onClick={(e) => e.stopPropagation()}><Bi name="three-dots" /></button>
          </Menu.Target>
          <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
            <Menu.Item onClick={() => openRenameSession(session, groupId)}>Rename</Menu.Item>
            <Menu.Item onClick={() => duplicateSession(session, groupId)}>Duplicate</Menu.Item>
            <Menu.Label>Export</Menu.Label>
            <Menu.Item leftSection={<Bi name="filetype-json" />} onClick={() => exportSession(session, 'json')}>JSON</Menu.Item>
            <Menu.Item leftSection={<Bi name="markdown" />} onClick={() => exportSession(session, 'markdown')}>Markdown</Menu.Item>
            <Menu.Item leftSection={<Bi name="folder-symlink" />} onClick={() => void revealSession(session, groupId)}>Reveal in Finder</Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<Bi name="trash3" />} onClick={() => deleteSession(session.id, groupId)}>Delete</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );

  return (
    <div
      className={draggingFiles ? 'appChatShell draggingFiles' : 'appChatShell'}
      onDragOver={handleChatDragOver}
      onDragLeave={handleChatDragLeave}
      onDrop={handleChatDrop}
    >
      <aside className="appChatSidebar">
        <div className="chatSidebarHeader">
          <Text className="chatSidebarHeading">Chats</Text>
          <Menu position="bottom-end" shadow="xl" width={310} classNames={{ dropdown: 'chatSortMenu' }}>
            <Menu.Target>
              <button type="button" className="chatSidebarMenuBtn" aria-label="Chat sorting options"><Bi name="three-dots" /></button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Sort by</Menu.Label>
              <Menu.Item onClick={() => setChatSortBy('created')} leftSection={chatSortBy === 'created' ? '✓' : ''}>Date created</Menu.Item>
              <Menu.Item onClick={() => setChatSortBy('updated')} leftSection={chatSortBy === 'updated' ? '✓' : ''}>Date updated</Menu.Item>
              <Menu.Item onClick={() => setChatSortBy('tokens')} leftSection={chatSortBy === 'tokens' ? '✓' : ''}>Conversation length (tokens)</Menu.Item>
              <Menu.Divider />
              <Menu.Label>Sort direction</Menu.Label>
              <Menu.Item onClick={() => setChatSortDirection('asc')} leftSection={chatSortDirection === 'asc' ? '✓' : ''}>Oldest first</Menu.Item>
              <Menu.Item onClick={() => setChatSortDirection('desc')} leftSection={chatSortDirection === 'desc' ? '✓' : ''}>Newest first</Menu.Item>
              <Menu.Divider />
              <Menu.Item onClick={() => setShowChatTokenCount(value => !value)} leftSection={showChatTokenCount ? '✓' : ''}>Show token count in listings</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>

        <TextInput
          className="chatSidebarSearch"
          leftSection={<Bi name="search" />}
          placeholder="Search chats..."
          value={chatSearch}
          onChange={(event) => setChatSearch(event.currentTarget.value)}
        />

        <button type="button" className="chatSidebarCreateBtn" onClick={() => setGroupOpen(true)}>
          <Bi name="folder-plus" /> New Folder
        </button>

        <div className="chatFolderList">
          {groups.map(group => {
            const groupSessions = visibleSidebarSessions(sidebarSessionsByGroup[group.id] ?? []);
            const groupMatches = group.name.toLowerCase().includes(chatSearch.trim().toLowerCase());
            if (chatSearch.trim() && !groupMatches && groupSessions.length === 0) return null;
            return (
              <div key={group.id} className="chatFolderBlock">
                <div className={activeGroupId === group.id ? 'appChatGroupRow active' : 'appChatGroupRow'}>
                  <button type="button" className={activeGroupId === group.id ? 'appChatSideButton active' : 'appChatSideButton'} onClick={() => { setActiveGroupId(group.id); setInput(''); setError(null); }}>
                    <span><Bi name="folder2" /> {group.name}</span>
                  </button>
                  <button type="button" className="appChatGroupDelete" aria-label={`Delete ${group.name}`} title="Delete folder" onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onClick={e => { e.preventDefault(); e.stopPropagation(); setGroupToDelete(group); }}><Bi name="x-lg" /></button>
                </div>
                <div className="chatFolderSessions">
                  {activeGroupId === group.id ? (
                    <button type="button" className="chatFolderNewChatBtn" onClick={() => createSession(group.id)}>+ New chat</button>
                  ) : null}
                  {groupSessions.map(session => renderSessionRow(session, group.id))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="chatLooseSection">
          <Group justify="space-between" align="center">
            <Text className="chatSidebarTitle">Chats</Text>
            <button type="button" className="chatAddGroupBtn" onClick={() => createSession('')}>+ Chat</button>
          </Group>
          <Stack gap={2} mt={6}>
            {sessionsLoading && activeGroupId === ''
              ? <Text c="dimmed" size="xs" px="xs">Loading…</Text>
              : ungroupedSidebarSessions.length === 0
                ? <div className="sidebarEmptyState">
                    <Text fw={800} size="sm">No loose chats</Text>
                    <Text c="dimmed" size="xs">Create a chat here, or create a folder above for project work.</Text>
                  </div>
                : ungroupedSidebarSessions.map(session => renderSessionRow(session, ''))
            }
          </Stack>
        </div>
      </aside>

      <main className="appChatMain">
        <div className="appChatTopbar">
          <div className="appChatModelControl">
            {modelOptions.length === 0
              ? <Select label="Model" data={[]} placeholder="No loaded model" disabled />
              : <Select label="Model" data={modelOptions} value={model} onChange={v => updateActiveModel(v ?? '')} disabled={loading} />
            }
          </div>
          <Text size="sm" c="dimmed" style={{ alignSelf: 'flex-end', paddingBottom: 8 }} truncate>
            {activeSession?.title ?? ''}
          </Text>
        </div>
        <Textarea
          className="appChatSystemPrompt"
          placeholder="System prompt (optional)"
          value={systemPrompt}
          onChange={e => updateActiveSession({ systemPrompt: e.currentTarget.value })}
          autosize
          minRows={3}
          maxRows={6}
          disabled={loading || !activeSession}
        />
        {loadedStatus.loading && !loadedStatus.data ? <Text c="dimmed" size="xs">Checking loaded models...</Text> : null}
        {loadedStatus.error ? <ErrorCard message={loadedStatus.error} /> : null}
        {error ? <ErrorCard message={error} /> : null}

        <div className="appChatMessages">
          {messages.length === 0
            ? <div className="chatEmptyState">
                <Text fw={900}>Start a conversation</Text>
                <Text c="dimmed" size="sm">
                  {model ? 'Type a message below, or drag files into the chat to attach them.' : 'Load a model in Server, then select it here before chatting.'}
                </Text>
                <Group justify="center" gap="xs">
                  <Badge variant="light" color={model ? 'green' : 'gray'}>{model ? `Model: ${model}` : 'No model selected'}</Badge>
                  <Badge variant="outline" color={visionCapable ? 'violet' : 'gray'}>{visionCapable ? 'Images supported' : 'Text only'}</Badge>
                </Group>
              </div>
            : <div className="appChatMsgList">
                {messages.map((msg, i) => (
                  msg.role === 'user' ? (
                    <div key={i} className="appChatMsgRow user">
                      <div className="appChatMsgTime">{formatChatTime(msg.timestamp)}</div>
                      <div className="appChatUserBubble">
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="appChatMsgAttachments">
                            {msg.attachments.map((att, j) => (
                              att.kind === 'image'
                                ? <img key={j} src={att.content} alt={att.name} className="appChatThumb" title={att.name} />
                                : <div key={j} className="appChatFileThumb">📄 {att.name} · {formatBytes(att.size)}</div>
                            ))}
                          </div>
                        )}
                        {msg.content ? <span>{displayChatContent(msg.content)}</span> : null}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="appChatMsgRow assistant">
                      <div className="appChatAsstModelLabel">{msg.meta?.model ?? model}</div>
                      <div className="appChatAsstContent">
                        <MarkdownView content={msg.content} />
                      </div>
                      {msg.meta && (
                        <div className="appChatMsgStatRow">
                          {msg.meta.time_ms && msg.meta.output_tokens
                          ? <span><Bi name="lightbulb" /> {(msg.meta.output_tokens / (msg.meta.time_ms / 1000)).toFixed(1)} tok/s</span>
                          : null}
                          {msg.meta.output_tokens ? <span>· {msg.meta.output_tokens} tokens</span> : null}
                          {msg.meta.time_ms ? <span>· {(msg.meta.time_ms / 1000).toFixed(2)}s</span> : null}
                          {msg.meta.finish_reason ? <span>· Stop: {msg.meta.finish_reason}</span> : null}
                        </div>
                      )}
                      <div className="appChatMsgActions">
                        <button type="button" className="appChatMsgAction" title="Copy" onClick={() => void navigator.clipboard.writeText(msg.content)}>
                          <Bi name="copy" />
                        </button>
                        <button type="button" className="appChatMsgAction" title="Delete" onClick={() => updateActiveSession(s => ({ messages: s.messages.filter((_, idx) => idx !== i) }))}>
                          <Bi name="trash3" />
                        </button>
                      </div>
                    </div>
                  )
                ))}
                {loading && (
                  <div className="appChatMsgRow assistant">
                    <div className="appChatAsstModelLabel">{model}</div>
                    <div className="appChatAsstContent appChatAsstThinking">
                      <span className="thinkingDot" /><span className="thinkingDot" /><span className="thinkingDot" />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
          }
        </div>

        <div className="appChatComposer">
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void addAttachments(event.currentTarget.files)} />
          <div className={`chatComposerBox${draggingFiles ? ' dragging' : ''}`}>
            {draggingFiles ? <div className="chatComposerDropHint">Drop files here to attach</div> : null}
            {attachmentError ? <div className="chatComposerError">{attachmentError}</div> : null}
            {pendingAttachments.length > 0 ? (
              <div className="chatAttachmentTray">
                {pendingAttachments.map(attachment => (
                  <span key={attachment.id} className={`chatAttachmentPill ${attachment.kind}`}>
                    <Bi name={attachment.kind === 'image' ? 'image' : 'file-earmark-text'} />
                    <span className="chatAttachmentPillName" title={attachment.name}>
                      {attachment.name}
                    </span>
                    <button type="button" className="chatAttachmentPillRemove" onClick={() => removeAttachment(attachment.id)} title="Remove">×</button>
                  </span>
                ))}
              </div>
            ) : null}
            <Textarea
              classNames={{ input: 'chatComposerTextarea' }}
              placeholder={model ? 'Message the model…' : 'Select a model to start chatting'}
              value={input}
              onChange={e => setInput(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              autosize
              minRows={2}
              maxRows={10}
              disabled={loading || !model}
            />
            <div className="chatComposerToolbar">
              <div className="chatComposerLeft">
                <button type="button" className="chatComposerIconBtn" title="Attach file" onClick={() => fileInputRef.current?.click()} disabled={loading}>
                  <Bi name="paperclip" />
                </button>
                <button type="button" className="chatComposerIconBtn" title="Tools (coming soon)" disabled>
                  <Bi name="wrench" />
                </button>
                {thinkingCapable && (
                  <button type="button" className={`chatComposerToggle chatToggleThink${thinkEnabled ? ' active' : ''}`} onClick={() => setThinkEnabled(v => !v)}>
                    <Bi name="lightbulb" />
                    Think
                  </button>
                )}
                {visionCapable && (
                  <button type="button" className={`chatComposerToggle chatToggleVision${pendingAttachments.some(a => a.kind === 'image') ? ' active' : ''}`} onClick={() => fileInputRef.current?.click()} disabled={loading}>
                    <Bi name="eye" />
                    Vision
                  </button>
                )}
              </div>
              <div className="chatComposerRight">
                {model && (() => {
                  const pct = estimatedTokens / contextWindow;
                  const cls = pct >= 0.85 ? 'danger' : pct >= 0.6 ? 'warn' : 'ok';
                  return (
                    <span className={`chatContextCount ${cls}`} title={`~${estimatedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens used`}>
                      {estimatedTokens.toLocaleString()} / {contextWindow.toLocaleString()}
                    </span>
                  );
                })()}
                <div className="chatComposerDivider" />
                <button type="button" className="chatSendCircleBtn" onClick={send} disabled={(!input.trim() && pendingAttachments.length === 0) || !model || loading} title="Send (Enter)">
                  <Bi name="arrow-up" />
                </button>
              </div>
            </div>
          </div>
          <p className="chatComposerHint">Enter to send · Shift+Enter for new line</p>
        </div>
      </main>

      {/* Inference params sidebar — disabled, reserved for future feature */}

      <Modal opened={Boolean(sessionToDelete)} onClose={() => setSessionToDelete(null)} title="Delete chat?" size="sm">
        <Stack>
          <Text size="sm">Delete <strong>{sessionToDelete?.title}</strong>? This cannot be undone.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSessionToDelete(null)}>Cancel</Button>
            <Button color="red" onClick={confirmDeleteSession}>Delete</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(renameSessionId)} onClose={() => setRenameSessionId(null)} title="Rename Session" size="sm">
        <Stack>
          <TextInput label="Session name" value={renameTitle} onChange={(e) => setRenameTitle(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveSessionRename(); }} autoFocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenameSessionId(null)}>Cancel</Button>
            <Button onClick={saveSessionRename}>Save</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={groupOpen} onClose={() => setGroupOpen(false)} title="Create Chat Group" size="sm">
        <Stack>
          <Text c="dimmed" size="sm">A group is stored as its own subfolder inside the session folder.</Text>
          <TextInput label="Group name" value={groupName} onChange={(e) => setGroupName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createGroup(); }} autoFocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setGroupOpen(false)}>Cancel</Button>
            <Button onClick={createGroup} disabled={!groupName.trim()}>Create</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(groupToDelete)} onClose={() => deletingGroup ? undefined : setGroupToDelete(null)} title="Delete Chat Group" size="sm">
        <Stack>
          <Text>
            Delete <strong>{groupToDelete?.name}</strong> and all chat sessions inside this group?
          </Text>
          <Text c="dimmed" size="sm">This removes the group folder and every saved session in it.</Text>
          <Group justify="flex-end">
            <Button variant="default" disabled={deletingGroup} onClick={() => setGroupToDelete(null)}>Cancel</Button>
            <Button color="red" variant="light" loading={deletingGroup} onClick={() => void confirmDeleteGroup()}>Delete group</Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
