let mode = 'login';
const auth = document.querySelector('#auth');
const dashboard = document.querySelector('#dashboard');
const authTitle = document.querySelector('#authTitle');
const authSubtitle = document.querySelector('#authSubtitle');
const authSubmit = document.querySelector('#authSubmit');
const authError = document.querySelector('#authError');
const username = document.querySelector('#username');
const displayName = document.querySelector('#displayName');
const password = document.querySelector('#password');
const errorBox = document.querySelector('#error');
const defaultDashboardStart = new Date();
defaultDashboardStart.setHours(0, 0, 0, 0);
defaultDashboardStart.setDate(defaultDashboardStart.getDate() - 6);
const dashboardState = { scope: 'all', range: '7d', startTs: Math.floor(defaultDashboardStart.getTime() / 1000), endTs: null };
const modelChartColors = ['#14b8a6', '#4285f4', '#f2418f', '#9b5cf6', '#ff8a33', '#61c46d', '#facc15', '#38bdf8', '#fb7185', '#a3e635'];
const hiddenChartModels = new Set();
const logsState = { items: [], page: 0, shown: 25 };
let overviewExportData = null;
const logColumns = [
  ['time', 'Time'],
  ['userId', 'True Name'],
  ['username', 'Username'],
  ['endpoint', 'Endpoint'],
  ['model', 'Model'],
  ['key', 'Key'],
  ['input', 'Input'],
  ['output', 'Output'],
  ['status', 'Status'],
  ['details', 'Details'],
];
const visibleLogColumns = new Set(logColumns.map(column => column[0]));
const profileKeysState = { items: [], page: 0, shown: 25 };
const adminState = { users: [], keys: [], usersPage: 0, usersShown: 25, keysPage: 0, keysShown: 25 };
const chatState = { groups: [], sessions: [], sessionsByGroup: {}, activeGroupId: '', activeSessionId: null, loadedModels: [], sending: false, pendingAttachments: [], search: '', sortBy: 'updated', sortDirection: 'desc', showTokenCount: false };
const dateRangeState = { baseMonth: firstOfMonth(addMonths(new Date(), -1)), start: '', end: '' };
const MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

document.querySelector('#logout').addEventListener('click', () => {
  localStorage.removeItem('llmeter_web_api_key');
  localStorage.removeItem('llmeter_web_user');
  showAuth();
});
document.querySelector('#refresh').addEventListener('click', refreshAll);
document.querySelector('#refreshUsage').addEventListener('click', refreshAll);
document.querySelector('#rangePill').addEventListener('click', () => setRange('custom'));
document.querySelector('#downloadOverviewCsv').addEventListener('click', downloadOverviewCsv);
document.querySelector('#refreshServer').addEventListener('click', refreshServer);
document.querySelector('#closeDateRange').addEventListener('click', closeDateRangeModal);
document.querySelector('#applyDateRange').addEventListener('click', applyDateRange);
document.querySelector('#rangePrevMonth').addEventListener('click', () => { dateRangeState.baseMonth = addMonths(dateRangeState.baseMonth, -1); renderDateRangeModal(); });
document.querySelector('#rangeNextMonth').addEventListener('click', () => { dateRangeState.baseMonth = addMonths(dateRangeState.baseMonth, 1); renderDateRangeModal(); });
document.querySelectorAll('[data-range-preset]').forEach(button => button.addEventListener('click', () => applyDatePreset(button.dataset.rangePreset)));
document.querySelector('#logsShown').addEventListener('change', event => { logsState.shown = Number(event.target.value) || 25; logsState.page = 0; renderLogsPage(); });
document.querySelector('#logsPrev').addEventListener('click', () => { logsState.page = Math.max(0, logsState.page - 1); renderLogsPage(); });
document.querySelector('#logsNext').addEventListener('click', () => { logsState.page += 1; renderLogsPage(); });
document.querySelector('#openKeyModal').addEventListener('click', openKeyModal);
document.querySelector('#saveProfile').addEventListener('click', saveProfile);
document.querySelector('#closeKeyModal').addEventListener('click', closeKeyModal);
document.querySelector('#cancelKeyModal').addEventListener('click', closeKeyModal);
document.querySelector('#createProfileKey').addEventListener('click', createProfileKey);
document.querySelector('#profileKeysShown').addEventListener('change', event => { profileKeysState.shown = Number(event.target.value) || 25; profileKeysState.page = 0; renderProfileKeysPage(); });
document.querySelector('#profileKeysPrev').addEventListener('click', () => { profileKeysState.page = Math.max(0, profileKeysState.page - 1); renderProfileKeysPage(); });
document.querySelector('#profileKeysNext').addEventListener('click', () => { profileKeysState.page += 1; renderProfileKeysPage(); });
document.querySelector('#adminCreateUser').addEventListener('click', adminCreateUser);
document.querySelector('#adminCreateKey').addEventListener('click', adminCreateKey);
document.querySelector('#adminUsersShown').addEventListener('change', event => { adminState.usersShown = Number(event.target.value) || 25; adminState.usersPage = 0; renderAdminUsers(); });
document.querySelector('#adminUsersPrev').addEventListener('click', () => { adminState.usersPage = Math.max(0, adminState.usersPage - 1); renderAdminUsers(); });
document.querySelector('#adminUsersNext').addEventListener('click', () => { adminState.usersPage += 1; renderAdminUsers(); });
document.querySelector('#adminKeysShown').addEventListener('change', event => { adminState.keysShown = Number(event.target.value) || 25; adminState.keysPage = 0; renderAdminKeys(); });
document.querySelector('#adminKeysPrev').addEventListener('click', () => { adminState.keysPage = Math.max(0, adminState.keysPage - 1); renderAdminKeys(); });
document.querySelector('#adminKeysNext').addEventListener('click', () => { adminState.keysPage += 1; renderAdminKeys(); });
document.querySelector('#newChatGroup').addEventListener('click', createChatGroup);
document.querySelector('#newChatSession').addEventListener('click', createChatSession);
document.querySelector('#chatSearch').addEventListener('input', event => { chatState.search = event.target.value; renderChatGroups(); renderChatSessions(); });
document.querySelector('#chatSortToggle').addEventListener('click', () => { const menu = document.querySelector('#chatSortMenu'); menu.hidden = !menu.hidden; });
document.querySelectorAll('[data-chat-sort]').forEach(button => button.addEventListener('click', () => { chatState.sortBy = button.dataset.chatSort; renderChatGroups(); renderChatSessions(); }));
document.querySelectorAll('[data-chat-direction]').forEach(button => button.addEventListener('click', () => { chatState.sortDirection = button.dataset.chatDirection; renderChatGroups(); renderChatSessions(); }));
document.querySelector('#toggleChatTokenCount').addEventListener('click', () => { chatState.showTokenCount = !chatState.showTokenCount; renderChatGroups(); renderChatSessions(); });
document.querySelector('#renameChatSession').addEventListener('click', renameChatSession);
document.querySelector('#deleteChatSession').addEventListener('click', deleteChatSession);
document.querySelector('#sendChat').addEventListener('click', sendChatMessage);
document.querySelector('#attachChatFile').addEventListener('click', () => document.querySelector('#chatFileInput').click());
document.querySelector('#chatFileInput').addEventListener('change', event => addChatAttachments(event.target.files));
const chatPanel = document.querySelector('#panel-chat');
chatPanel.addEventListener('dragover', event => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  chatPanel.classList.add('draggingFiles');
});
chatPanel.addEventListener('dragleave', event => {
  if (!chatPanel.contains(event.relatedTarget)) chatPanel.classList.remove('draggingFiles');
});
chatPanel.addEventListener('drop', event => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  chatPanel.classList.remove('draggingFiles');
  addChatAttachments(event.dataTransfer.files);
});
document.querySelector('#chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendChatMessage(); });
document.querySelector('#chatSystemPrompt').addEventListener('change', saveActiveChatSession);
document.querySelector('#chatModel').addEventListener('change', saveActiveChatSession);
document.querySelector('#closeLogModal').addEventListener('click', closeLogModal);
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
document.querySelectorAll('[data-scope]').forEach(button => button.addEventListener('click', () => setScope(button.dataset.scope)));
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => setRange(button.dataset.range)));
authSubmit.addEventListener('click', submitAuth);
password.addEventListener('keydown', event => { if (event.key === 'Enter') submitAuth(); });
document.querySelector('#search').addEventListener('keydown', event => { if (event.key === 'Enter') refreshAll(); });

init();

async function init() {
  renderLogColumnToggles();
  try {
    const setup = await getJson('/web/setup-state', false);
    mode = setup.needs_setup ? 'setup' : 'login';
    if (!setup.needs_setup && localStorage.getItem('llmeter_web_api_key')) {
      showDashboard();
      await refreshAll();
      return;
    }
    showAuth();
  } catch (error) {
    showAuthError(error.message);
  }
}

function showAuth() {
  auth.hidden = false;
  dashboard.hidden = true;
  authError.hidden = true;
  displayName.hidden = mode !== 'setup';
  document.querySelector('#displayNameLabel').hidden = mode !== 'setup';
  document.querySelector('#authPasswordPolicy').hidden = mode !== 'setup';
  authTitle.textContent = 'AI Server Monitor';
  authSubtitle.textContent = mode === 'setup' ? 'Create the first admin account.' : 'Log in before viewing the dashboard.';
  authSubmit.textContent = mode === 'setup' ? 'Create admin' : 'Log in';
  if (mode === 'setup' && !username.value) username.value = 'admin';
  if (mode === 'setup' && !displayName.value) displayName.value = 'Administrator';
}

function showDashboard() {
  const user = JSON.parse(localStorage.getItem('llmeter_web_user') || 'null');
  document.querySelector('#signedIn').textContent = user ? user.display_name : '';
  document.querySelector('#adminBadge').hidden = user?.role !== 'admin';
  document.querySelector('#adminTab').hidden = user?.role !== 'admin';
  document.querySelectorAll('[data-scope="all"]').forEach(button => { button.hidden = user?.role !== 'admin'; });
  if (user?.role !== 'admin') dashboardState.scope = 'mine';
  updateFilterButtons();
  document.querySelector('#profileRole').textContent = user?.role || '-';
  document.querySelector('#profileUid').textContent = user?.uid || '-';
  document.querySelector('#profileUsernameInput').value = user?.username || '';
  document.querySelector('#profileNameInput').value = user?.display_name || '';
  document.querySelector('#profilePasswordInput').value = '';
  auth.hidden = true;
  dashboard.hidden = false;
}

function setTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  for (const panel of ['dashboard', 'chat', 'logs', 'server', 'admin', 'profile']) {
    document.querySelector(`#panel-${panel}`).hidden = panel !== tab;
  }
  if (tab === 'dashboard' || tab === 'logs') refreshAll();
  if (tab === 'chat') refreshChat();
  if (tab === 'server') refreshServer();
  if (tab === 'profile') refreshProfile();
  if (tab === 'admin') refreshAdmin();
}

function setScope(scope) {
  dashboardState.scope = scope;
  updateFilterButtons();
  refreshAll();
}

function setRange(range) {
  dashboardState.range = range;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  dashboardState.startTs = null;
  dashboardState.endTs = null;
  if (range === 'today') dashboardState.startTs = Math.floor(today.getTime() / 1000);
  if (range === '7d') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    dashboardState.startTs = Math.floor(start.getTime() / 1000);
  }
  if (range === '30d') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    dashboardState.startTs = Math.floor(start.getTime() / 1000);
  }
  if (range === 'custom') {
    openDateRangeModal();
    return;
  }
  updateFilterButtons();
  refreshAll();
}

function updateFilterButtons() {
  document.querySelectorAll('[data-scope]').forEach(button => {
    const active = button.dataset.scope === dashboardState.scope;
    button.classList.toggle('active', active);
    button.classList.toggle('secondary', !active);
  });
  document.querySelectorAll('[data-range]').forEach(button => {
    const active = button.dataset.range === dashboardState.range;
    button.classList.toggle('active', active);
    button.classList.toggle('secondary', !active);
  });
  const rangePill = document.querySelector('#rangePill');
  if (rangePill) rangePill.textContent = rangeLabel(dashboardState.range, dashboardState.startTs, dashboardState.endTs);
}

function openDateRangeModal() {
  dateRangeState.start = dashboardState.startTs ? dateKey(new Date(dashboardState.startTs * 1000)) : '';
  dateRangeState.end = dashboardState.endTs ? dateKey(new Date(dashboardState.endTs * 1000)) : '';
  renderDateRangeModal();
  document.querySelector('#dateRangeModal').hidden = false;
}

function closeDateRangeModal() {
  document.querySelector('#dateRangeModal').hidden = true;
}

function applyDateRange() {
  if (!dateRangeState.start) return;
  const start = dateRangeState.start;
  const end = dateRangeState.end || dateRangeState.start;
  dashboardState.range = 'custom';
  dashboardState.startTs = Math.floor(new Date(`${start}T00:00:00`).getTime() / 1000);
  dashboardState.endTs = Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000);
  closeDateRangeModal();
  updateFilterButtons();
  refreshAll();
}

function applyDatePreset(kind) {
  const today = startOfLocalDay(new Date());
  let start = today;
  if (kind === 'week') start = addDays(today, -today.getDay());
  if (kind === 'month') start = new Date(today.getFullYear(), today.getMonth(), 1);
  if (kind === '7d') start = addDays(today, -6);
  if (kind === '14d') start = addDays(today, -13);
  if (kind === '30d') start = addDays(today, -29);
  dateRangeState.start = dateKey(start);
  dateRangeState.end = dateKey(today);
  applyDateRange();
}

function renderDateRangeModal() {
  const root = document.querySelector('#rangeMonths');
  root.innerHTML = renderRangeMonth(dateRangeState.baseMonth) + renderRangeMonth(addMonths(dateRangeState.baseMonth, 1));
  document.querySelector('#rangeDraftLabel').textContent = `${dateRangeState.start || 'Start'} → ${dateRangeState.end || 'End'}`;
  document.querySelector('#applyDateRange').disabled = !dateRangeState.start;
  root.querySelectorAll('[data-range-day]').forEach(button => button.addEventListener('click', () => chooseDateRangeDay(button.dataset.rangeDay)));
}

function renderRangeMonth(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const totalDays = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const blanks = Array.from({ length: first.getDay() }, () => '<span></span>').join('');
  const today = startOfLocalDay(new Date());
  const days = Array.from({ length: totalDays }, (_, index) => {
    const day = new Date(month.getFullYear(), month.getMonth(), index + 1);
    const key = dateKey(day);
    const selected = key === dateRangeState.start || key === dateRangeState.end;
    const inRange = dateRangeState.start && dateRangeState.end && key > dateRangeState.start && key < dateRangeState.end;
    const disabled = day > today ? 'disabled' : '';
    const className = selected ? 'selected' : inRange ? 'inRange' : '';
    return `<button type="button" class="${className}" ${disabled} data-range-day="${key}">${day.getDate()}</button>`;
  }).join('');
  return `<div class="rangeCalendarMonth"><h3>${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3><div class="rangeCalendarWeekdays">${['Su','Mo','Tu','We','Th','Fr','Sa'].map(day => `<span>${day}</span>`).join('')}</div><div class="rangeCalendarGrid">${blanks}${days}</div></div>`;
}

function chooseDateRangeDay(day) {
  if (!dateRangeState.start || (dateRangeState.start && dateRangeState.end) || day < dateRangeState.start) {
    dateRangeState.start = day;
    dateRangeState.end = '';
  } else {
    dateRangeState.end = day;
  }
  renderDateRangeModal();
}

async function submitAuth() {
  authError.hidden = true;
  try {
    const path = mode === 'setup' ? '/web/setup' : '/web/login';
    const body = mode === 'setup'
      ? { username: username.value.trim(), display_name: displayName.value.trim(), password: password.value }
      : { username: username.value.trim(), password: password.value };
    const result = await postJson(path, body);
    localStorage.setItem('llmeter_web_api_key', result.api_key);
    localStorage.setItem('llmeter_web_user', JSON.stringify(result.user));
    mode = 'login';
    showDashboard();
    await refreshAll();
  } catch (error) {
    showAuthError(error.message);
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('llmeter_web_api_key') || ''}` };
}

async function getJson(path, withAuth = true) {
  const response = await fetch(path, { headers: withAuth ? authHeaders() : {} });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || response.statusText);
  return body;
}

async function postJson(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || response.statusText);
  return data;
}

async function postAuthJson(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || response.statusText);
  return data;
}

async function refreshAll() {
  errorBox.hidden = true;
  try {
    const params = new URLSearchParams();
    params.set('scope', dashboardState.scope);
    if (dashboardState.startTs !== null) params.set('start_ts', String(dashboardState.startTs));
    if (dashboardState.endTs !== null) params.set('end_ts', String(dashboardState.endTs));
    const summary = await getJson(`/web/dashboard?${params.toString()}`);
    document.querySelector('#requests').textContent = summary.request_count.toLocaleString();
    document.querySelector('#inputTokens').textContent = summary.input_tokens.toLocaleString();
    document.querySelector('#outputTokens').textContent = summary.output_tokens.toLocaleString();
    document.querySelector('#totalTokens').textContent = (summary.input_tokens + summary.output_tokens).toLocaleString();
    const displayDailyUsage = fillDailyUsageRange(summary.daily_usage || [], dashboardState.startTs, dashboardState.endTs);
    const displayDays = displayDailyUsage.map(point => point.day);
    overviewExportData = { summary, displayDailyUsage };
    renderSpark('#requestsSpark', displayDailyUsage.map(point => point.requests), 'blue');
    renderSpark('#inputSpark', displayDailyUsage.map(point => point.input_tokens), 'green');
    renderSpark('#outputSpark', displayDailyUsage.map(point => point.output_tokens), 'purple');
    renderSpark('#totalSpark', displayDailyUsage.map(point => point.total_tokens), 'orange');
    renderModels(summary.model_usage || []);
    renderDailyModelChart(summary.model_daily_usage || [], displayDays);
    const query = encodeURIComponent(document.querySelector('#search').value || '');
    renderLogs(await getJson(`/web/logs?search=${query}`));
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function refreshProfile() {
  errorBox.hidden = true;
  try {
    const user = JSON.parse(localStorage.getItem('llmeter_web_user') || 'null');
    document.querySelector('#profileRole').textContent = user?.role || '-';
    document.querySelector('#profileUid').textContent = user?.uid || '-';
    document.querySelector('#profileUsernameInput').value = user?.username || '';
    document.querySelector('#profileNameInput').value = user?.display_name || '';
    profileKeysState.items = await getJson('/web/api-keys');
    profileKeysState.page = 0;
    renderProfileKeysPage();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function refreshServer() {
  errorBox.hidden = true;
  try {
    const data = await getJson('/web/server');
    renderServerModels(data.loaded_models || []);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function refreshChat() {
  errorBox.hidden = true;
  try {
    const server = await getJson('/web/server');
    chatState.loadedModels = (server.loaded_models || []).filter(item => item.loaded && item.model_name);
    renderChatModelOptions();
    chatState.groups = await getJson('/web/chat/groups');
    if (!chatState.groups.some(group => group.id === chatState.activeGroupId)) {
      chatState.activeGroupId = '';
    }
    await loadSidebarChatSessions();
    renderChatGroups();
    await loadChatSessions();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function loadSidebarChatSessions() {
  const groupIds = ['', ...chatState.groups.map(group => group.id)];
  const entries = await Promise.all(groupIds.map(async groupId => {
    const params = new URLSearchParams({ group_id: groupId });
    const sessions = await getJson(`/web/chat/sessions?${params.toString()}`);
    return [groupId, sessions];
  }));
  chatState.sessionsByGroup = Object.fromEntries(entries);
}

async function loadChatSessions() {
  const params = new URLSearchParams({ group_id: chatState.activeGroupId });
  chatState.sessions = await getJson(`/web/chat/sessions?${params.toString()}`);
  chatState.sessionsByGroup[chatState.activeGroupId] = chatState.sessions;
  if (!chatState.sessions.some(session => session.id === chatState.activeSessionId)) {
    chatState.activeSessionId = chatState.sessions[0]?.id || null;
  }
  renderChatSessions();
  renderActiveChatSession();
}

function activeChatSession() {
  return chatState.sessions.find(session => session.id === chatState.activeSessionId) || null;
}

function chatSessionTokenEstimate(session) {
  return (session.messages || []).reduce((sum, message) => sum + Math.ceil(String(message.content || '').length / 4), 0);
}

function visibleChatSessions(items) {
  const needle = chatState.search.trim().toLowerCase();
  const filtered = needle ? items.filter(session => String(session.title || '').toLowerCase().includes(needle)) : items;
  return [...filtered].sort((a, b) => {
    const valueA = chatState.sortBy === 'created' ? (a.createdAt || a.created_at || 0) : chatState.sortBy === 'tokens' ? chatSessionTokenEstimate(a) : (a.updatedAt || a.updated_at || 0);
    const valueB = chatState.sortBy === 'created' ? (b.createdAt || b.created_at || 0) : chatState.sortBy === 'tokens' ? chatSessionTokenEstimate(b) : (b.updatedAt || b.updated_at || 0);
    return chatState.sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
  });
}

function emptyChatSession() {
  const now = Date.now();
  return {
    id: `session-${Date.now()}`,
    title: 'New chat',
    model: chatState.loadedModels[0]?.model_name || '',
    systemPrompt: '',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function renderChatGroups() {
  const root = document.querySelector('#chatGroups');
  root.innerHTML = chatState.groups.map(group => {
    const sessions = visibleChatSessions(chatState.sessionsByGroup[group.id] || []);
    const groupMatches = group.name.toLowerCase().includes(chatState.search.trim().toLowerCase());
    if (chatState.search.trim() && !groupMatches && sessions.length === 0) return '';
    return `
      <div class="chatFolderBlock">
        <div class="chatGroupRow ${group.id === chatState.activeGroupId ? 'active' : ''}">
          <button class="${group.id === chatState.activeGroupId ? 'active' : ''}" data-chat-group="${escapeHtml(group.id)}"><i class="bi bi-folder2"></i> ${escapeHtml(group.name)}</button>
          <button class="chatGroupDelete" title="Delete folder" aria-label="Delete ${escapeHtml(group.name)}" data-delete-chat-group="${escapeHtml(group.id)}"><i class="bi bi-x-lg"></i></button>
        </div>
        <div class="chatFolderSessions">
          ${group.id === chatState.activeGroupId ? `<button class="chatFolderNewChatBtn" data-new-chat-in-group="${escapeHtml(group.id)}">+ New chat</button>` : ''}
          ${sessions.map(session => chatSessionButton(session, group.id)).join('')}
        </div>
      </div>
    `;
  }).join('');
  root.querySelectorAll('[data-chat-group]').forEach(button => button.addEventListener('click', async () => {
    chatState.activeGroupId = button.dataset.chatGroup;
    chatState.activeSessionId = null;
    renderChatGroups();
    await loadChatSessions();
  }));
  root.querySelectorAll('[data-new-chat-in-group]').forEach(button => button.addEventListener('click', () => createChatSession(button.dataset.newChatInGroup)));
  root.querySelectorAll('[data-chat-session]').forEach(button => button.addEventListener('click', () => selectChatSession(button.dataset.chatGroupId, button.dataset.chatSession)));
  root.querySelectorAll('[data-delete-chat-group]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    deleteChatGroup(button.dataset.deleteChatGroup);
  }));
  root.querySelectorAll('[data-delete-chat-group]').forEach(button => button.addEventListener('pointerdown', event => event.stopPropagation()));
}

function chatSessionButton(session, groupId) {
  const active = session.id === chatState.activeSessionId && groupId === chatState.activeGroupId;
  const meta = chatState.showTokenCount ? `${chatSessionTokenEstimate(session).toLocaleString()} tok` : relativeAge(session.updatedAt || session.updated_at || 0);
  return `<button class="${active ? 'active' : ''}" data-chat-group-id="${escapeHtml(groupId)}" data-chat-session="${escapeHtml(session.id)}"><span>${escapeHtml(session.title || 'Untitled')}</span><small>${escapeHtml(meta)}</small></button>`;
}

function selectChatSession(groupId, sessionId) {
  chatState.activeGroupId = groupId;
  chatState.sessions = chatState.sessionsByGroup[groupId] || [];
  chatState.activeSessionId = sessionId;
  renderChatGroups();
  renderChatSessions();
  renderActiveChatSession();
}

function renderChatSessions() {
  const root = document.querySelector('#chatSessions');
  document.querySelector('#newChatSession').disabled = false;
  const sessions = visibleChatSessions(chatState.sessionsByGroup[''] || []);
  root.innerHTML = sessions.length
    ? sessions.map(session => chatSessionButton(session, '')).join('')
    : '<p class="muted">No loose chats yet.</p>';
  root.querySelectorAll('[data-chat-session]').forEach(button => button.addEventListener('click', () => {
    selectChatSession(button.dataset.chatGroupId, button.dataset.chatSession);
  }));
}

function renderChatModelOptions() {
  const select = document.querySelector('#chatModel');
  select.innerHTML = chatState.loadedModels.length
    ? chatState.loadedModels.map(item => `<option value="${escapeHtml(item.model_name)}">${escapeHtml(item.model_name)}</option>`).join('')
    : '<option value="">No loaded model</option>';
}

function renderActiveChatSession() {
  const session = activeChatSession();
  const fallbackModel = chatState.loadedModels[0]?.model_name || '';
  document.querySelector('#chatTitle').value = session?.title || '';
  document.querySelector('#chatSystemPrompt').value = session?.systemPrompt || session?.system_prompt || '';
  if (session && (!session.model || !chatState.loadedModels.some(item => item.model_name === session.model))) {
    session.model = fallbackModel;
    if (fallbackModel) saveChatSession(session).catch(error => console.warn(error));
  }
  document.querySelector('#chatModel').value = session?.model || fallbackModel;
  document.querySelector('#deleteChatSession').disabled = !session;
  document.querySelector('#renameChatSession').disabled = !session;
  document.querySelector('#sendChat').disabled = !session || chatState.sending || !document.querySelector('#chatModel').value;
  renderChatMessages(session?.messages || []);
}

function renderChatMessages(messages) {
  const root = document.querySelector('#chatMessages');
  root.innerHTML = messages.length
    ? messages.map(message => `<div class="chatBubble ${escapeHtml(message.role)}"><div class="chatBubbleMeta"><strong>${escapeHtml(message.role)}</strong><time>${message.role === 'user' ? 'Request' : 'Response'}: ${escapeHtml(formatChatTime(message.timestamp))}</time></div><p>${escapeHtml(displayChatContent(message.content))}</p></div>`).join('')
    : '<p class="muted">Create or select a chat session to start.</p>';
  root.scrollTop = root.scrollHeight;
}

function renderChatAttachments() {
  const tray = document.querySelector('#chatAttachmentTray');
  tray.hidden = chatState.pendingAttachments.length === 0;
  tray.innerHTML = chatState.pendingAttachments.map(attachment => `<span class="chatAttachmentChip">${escapeHtml(attachment.name)} · ${formatBytes(attachment.size)} <button data-remove-attachment="${escapeHtml(attachment.id)}"><i class="bi bi-x-lg"></i></button></span>`).join('');
  tray.querySelectorAll('[data-remove-attachment]').forEach(button => button.addEventListener('click', () => {
    chatState.pendingAttachments = chatState.pendingAttachments.filter(attachment => attachment.id !== button.dataset.removeAttachment);
    renderChatAttachments();
  }));
}

async function addChatAttachments(files) {
  if (!files || files.length === 0) return;
  try {
    const next = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error(`${file.name} is too large. Max upload size is ${formatBytes(MAX_CHAT_ATTACHMENT_BYTES)}.`);
      const kind = file.type.startsWith('image/') ? 'image' : isTextLikeFile(file) ? 'text' : 'binary';
      const content = kind === 'text' ? await file.text() : await readFileAsDataUrl(file);
      next.push({ id: `att-${Date.now()}-${Math.random().toString(16).slice(2)}`, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, kind, content });
    }
    chatState.pendingAttachments.push(...next);
    renderChatAttachments();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    document.querySelector('#chatFileInput').value = '';
  }
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

async function createChatGroup() {
  const name = prompt('Project/group name');
  if (!name || !name.trim()) return;
  try {
    const group = await postAuthJson('/web/chat/groups', { name: name.trim() });
    chatState.groups.push(group);
    chatState.sessionsByGroup[group.id] = [];
    chatState.activeGroupId = group.id;
    chatState.activeSessionId = null;
    renderChatGroups();
    await loadChatSessions();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function deleteChatGroup(groupId) {
  const group = chatState.groups.find(item => item.id === groupId);
  if (!group) return;
  if (!confirm(`Delete "${group.name}" and all chats inside it?`)) return;
  try {
    await postAuthJson('/web/chat/groups/delete', { group_id: group.id });
    chatState.groups = await getJson('/web/chat/groups');
    delete chatState.sessionsByGroup[group.id];
    if (chatState.activeGroupId === group.id) {
      chatState.activeGroupId = '';
      chatState.activeSessionId = null;
    }
    await loadSidebarChatSessions();
    renderChatGroups();
    await loadChatSessions();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function createChatSession(groupId = chatState.activeGroupId) {
  const session = emptyChatSession();
  chatState.activeGroupId = groupId;
  chatState.sessions = [session, ...(chatState.sessionsByGroup[groupId] || [])];
  chatState.sessionsByGroup[groupId] = chatState.sessions;
  chatState.activeSessionId = session.id;
  await saveChatSession(session, groupId);
  renderChatGroups();
  renderChatSessions();
  renderActiveChatSession();
}

async function renameChatSession() {
  const session = activeChatSession();
  if (!session) return;
  const title = document.querySelector('#chatTitle').value.trim() || prompt('Session title', session.title || 'New chat');
  if (!title) return;
  session.title = title;
  session.updatedAt = Date.now();
  await saveChatSession(session);
  chatState.sessionsByGroup[chatState.activeGroupId] = chatState.sessions;
  renderChatGroups();
  renderChatSessions();
  renderActiveChatSession();
}

async function deleteChatSession() {
  const session = activeChatSession();
  if (!session) return;
  if (!confirm(`Delete "${session.title || 'this chat'}"? This cannot be undone.`)) return;
  await postAuthJson('/web/chat/sessions/delete', { group_id: chatState.activeGroupId, session_id: session.id });
  chatState.sessions = chatState.sessions.filter(item => item.id !== session.id);
  chatState.sessionsByGroup[chatState.activeGroupId] = chatState.sessions;
  chatState.activeSessionId = chatState.sessions[0]?.id || null;
  renderChatGroups();
  renderChatSessions();
  renderActiveChatSession();
}

async function saveActiveChatSession() {
  const session = activeChatSession();
  if (!session) return;
  session.title = document.querySelector('#chatTitle').value.trim() || session.title || 'New chat';
  session.model = document.querySelector('#chatModel').value;
  session.systemPrompt = document.querySelector('#chatSystemPrompt').value;
  session.updatedAt = Date.now();
  await saveChatSession(session);
  chatState.sessionsByGroup[chatState.activeGroupId] = chatState.sessions;
  renderChatGroups();
}

async function saveChatSession(session, groupId = chatState.activeGroupId) {
  await postAuthJson('/web/chat/sessions', { group_id: groupId, session });
}

async function sendChatMessage() {
  const session = activeChatSession();
  const input = document.querySelector('#chatInput').value.trim();
  const model = document.querySelector('#chatModel').value;
  if (!session || (!input && chatState.pendingAttachments.length === 0) || !model) return;
  chatState.sending = true;
  document.querySelector('#sendChat').disabled = true;
  session.model = model;
  session.systemPrompt = document.querySelector('#chatSystemPrompt').value;
  const attachmentsAtSend = [...chatState.pendingAttachments];
  const attachmentText = attachmentContext(attachmentsAtSend);
  const userContent = [input, attachmentText].filter(Boolean).join('\n\n');
  session.messages.push({ role: 'user', content: userContent, timestamp: Date.now() });
  session.updatedAt = Date.now();
  chatState.sessionsByGroup[chatState.activeGroupId] = chatState.sessions;
  document.querySelector('#chatInput').value = '';
  chatState.pendingAttachments = [];
  renderChatAttachments();
  renderChatMessages(session.messages);
  try {
    const requestMessages = normalizeChatRequestMessages([
      ...session.messages.slice(0, -1).map(message => ({ role: message.role, content: message.content })),
      { role: 'user', content: chatPromptContent(input, attachmentsAtSend) },
    ]);
    const fullMessages = session.systemPrompt.trim()
      ? [{ role: 'system', content: session.systemPrompt.trim() }, ...requestMessages]
      : requestMessages;
    const result = await postAuthJson('/v1/chat/completions', {
      model,
      messages: fullMessages,
      max_tokens: 2048,
    });
    const output = result.choices?.[0]?.message?.content || result.output || '';
    session.messages.push({ role: 'assistant', content: output, timestamp: Date.now() });
    session.updatedAt = Date.now();
    if (!session.title || session.title === 'New chat') session.title = input.slice(0, 48);
    await saveChatSession(session);
    chatState.sessionsByGroup[chatState.activeGroupId] = chatState.sessions;
    renderChatGroups();
    renderChatSessions();
    renderActiveChatSession();
  } catch (error) {
    session.messages.push({ role: 'assistant', content: `Error: ${error.message}`, timestamp: Date.now() });
    renderChatMessages(session.messages);
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    chatState.sending = false;
    renderActiveChatSession();
  }
}

function relativeAge(timestamp) {
  if (!timestamp) return '';
  const normalized = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const diff = Math.max(0, Math.floor((Date.now() - normalized) / 1000));
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 604800)}w`;
}

function formatChatTime(timestamp) {
  if (!timestamp) return '';
  const normalized = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(normalized).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLikeFile(file) {
  return file.type.startsWith('text/') || /\.(md|txt|json|csv|tsv|xml|yaml|yml|toml|rs|ts|tsx|js|jsx|py|html|css|sql|sh|zsh|log)$/i.test(file.name);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read file.'));
    reader.readAsDataURL(file);
  });
}

function attachmentContext(attachments) {
  if (!attachments.length) return '';
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

function chatPromptContent(input, attachments) {
  const images = attachments.filter(attachment => attachment.kind === 'image' && String(attachment.content || '').startsWith('data:'));
  const textContent = [input.trim(), attachmentContext(attachments)].filter(Boolean).join('\n\n');
  if (!images.length) return textContent;
  const parts = [];
  if (textContent.trim()) parts.push({ type: 'text', text: textContent });
  images.forEach(attachment => {
    parts.push({ type: 'image_url', image_url: { url: attachment.content } });
  });
  return parts;
}

function mergeChatContent(left, right) {
  const leftParts = Array.isArray(left) ? left : [{ type: 'text', text: String(left || '') }];
  const rightParts = Array.isArray(right) ? right : [{ type: 'text', text: String(right || '') }];
  return [...leftParts, ...rightParts];
}

function normalizeChatRequestMessages(messages) {
  const normalized = [];
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

function displayChatContent(content) {
  return String(content || '').replace(/data:[^\s;]+\/[^\s;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 attachment data hidden in chat view]');
}

function settingValue(value, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback;
  if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number' && !Number.isInteger(value)) return value.toFixed(4);
  return String(value);
}

function serverSetting(label, value) {
  return `<div class="serverSetting"><span>${escapeHtml(label)}</span><strong>${escapeHtml(settingValue(value))}</strong></div>`;
}

function renderServerModels(items) {
  const root = document.querySelector('#serverModels');
  const loaded = items.filter(item => item.loaded);
  const user = JSON.parse(localStorage.getItem('llmeter_web_user') || 'null');
  const isAdmin = user?.role === 'admin';
  if (!loaded.length) {
    root.innerHTML = '<div class="emptyState compact"><strong>No model loaded</strong><p>Load a model from the desktop app or CLI, then refresh this page to see its active settings.</p></div>';
    return;
  }
  root.innerHTML = loaded.map(item => {
    const settings = item.load_settings || {};
    return `<div class="serverModelCard">
      <div class="serverModelHeader">
        <div class="serverModelName">${escapeHtml(item.model_name || 'unknown')}</div>
        <div class="topbar"><span class="roleBadge user">Loaded</span>${isAdmin && item.model_id ? `<button class="dangerButton" data-delete-server-model="${item.model_id}" data-model-name="${escapeHtml(item.model_name || 'unknown')}">Delete</button>` : ''}</div>
      </div>
      <div class="serverSettingGrid">
        ${serverSetting('Context length', item.context_length)}
        ${serverSetting('CPU threads', item.n_threads)}
        ${serverSetting('Temperature', settings.temperature)}
        ${serverSetting('Max tokens', settings.limit_response_length ? settings.max_tokens : 'unlimited')}
        ${serverSetting('Context overflow', settings.context_overflow)}
        ${serverSetting('Stop strings', settings.stop_strings)}
        ${serverSetting('Top K', settings.top_k)}
        ${serverSetting('Repeat penalty', settings.repeat_penalty_enabled ? settings.repeat_penalty : 'off')}
        ${serverSetting('Presence penalty', settings.presence_penalty_enabled ? settings.presence_penalty : 'off')}
        ${serverSetting('Top P', settings.top_p_enabled ? settings.top_p : 'off')}
        ${serverSetting('Min P', settings.min_p_enabled ? settings.min_p : 'off')}
      </div>
    </div>`;
  }).join('');
  root.querySelectorAll('[data-delete-server-model]').forEach(button => button.addEventListener('click', () => deleteServerModel(Number(button.dataset.deleteServerModel), button.dataset.modelName || 'this model')));
}

async function deleteServerModel(modelId, modelName) {
  if (!confirm(`Delete model "${modelName}"? This will eject it and remove it from the model folder. This cannot be undone.`)) return;
  try {
    await postAuthJson('/web/admin/models/delete', { model_id: modelId });
    await refreshServer();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function saveProfile() {
  errorBox.hidden = true;
  document.querySelector('#profileSaved').hidden = true;
  try {
    const payload = {
      username: document.querySelector('#profileUsernameInput').value.trim(),
      display_name: document.querySelector('#profileNameInput').value.trim(),
      password: document.querySelector('#profilePasswordInput').value || null,
    };
    const user = await postAuthJson('/web/profile', payload);
    localStorage.setItem('llmeter_web_user', JSON.stringify(user));
    document.querySelector('#signedIn').textContent = user.display_name;
    document.querySelector('#profileRole').textContent = user.role;
    document.querySelector('#profileUid').textContent = user.uid || '-';
    document.querySelector('#profilePasswordInput').value = '';
    document.querySelector('#profileSaved').hidden = false;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function refreshAdmin() {
  errorBox.hidden = true;
  try {
    const data = await getJson('/web/admin');
    adminState.users = data.users || [];
    adminState.keys = data.api_keys || [];
    adminState.usersPage = 0;
    adminState.keysPage = 0;
    renderAdminUserOptions();
    renderAdminUsers();
    renderAdminKeys();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

function renderAdminUserOptions() {
  const select = document.querySelector('#adminKeyUser');
  select.innerHTML = adminState.users.map(user => `<option value="${user.id}">${escapeHtml(user.username)} (${escapeHtml(user.display_name)})</option>`).join('');
}

function renderAdminUsers() {
  const totalPages = Math.max(1, Math.ceil(adminState.users.length / adminState.usersShown));
  adminState.usersPage = Math.min(adminState.usersPage, totalPages - 1);
  const start = adminState.usersPage * adminState.usersShown;
  const pageItems = adminState.users.slice(start, start + adminState.usersShown);
  document.querySelector('#adminUsersPage').textContent = `Page ${adminState.usersPage + 1} / ${totalPages}`;
  document.querySelector('#adminUsersPrev').disabled = adminState.usersPage <= 0;
  document.querySelector('#adminUsersNext').disabled = adminState.usersPage >= totalPages - 1;
  document.querySelector('#adminUsers').innerHTML = pageItems.length
    ? pageItems.map(user => `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.display_name)}</td><td><span class="roleBadge ${user.role === 'admin' ? 'admin' : 'user'}">${escapeHtml(user.role)}</span></td><td><button class="webSwitch ${user.enabled ? 'on' : ''}" data-toggle-user="${user.id}" aria-label="Toggle account"><span></span></button></td><td><button class="dangerButton" data-delete-user="${user.id}">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No users found.</td></tr>';
  document.querySelectorAll('[data-toggle-user]').forEach(button => button.addEventListener('click', () => adminToggleUser(Number(button.dataset.toggleUser))));
  document.querySelectorAll('[data-delete-user]').forEach(button => button.addEventListener('click', () => adminDeleteUser(Number(button.dataset.deleteUser))));
}

function renderAdminKeys() {
  const totalPages = Math.max(1, Math.ceil(adminState.keys.length / adminState.keysShown));
  adminState.keysPage = Math.min(adminState.keysPage, totalPages - 1);
  const start = adminState.keysPage * adminState.keysShown;
  const pageItems = adminState.keys.slice(start, start + adminState.keysShown);
  document.querySelector('#adminKeysPage').textContent = `Page ${adminState.keysPage + 1} / ${totalPages}`;
  document.querySelector('#adminKeysPrev').disabled = adminState.keysPage <= 0;
  document.querySelector('#adminKeysNext').disabled = adminState.keysPage >= totalPages - 1;
  document.querySelector('#adminKeys').innerHTML = pageItems.length
    ? pageItems.map(key => `<tr><td>${escapeHtml(key.username || ('User ' + key.user_id))}</td><td>${escapeHtml(key.display_name || '-')}</td><td>${escapeHtml(key.label)}</td><td><code>${escapeHtml(key.key_prefix)}</code></td><td><button class="dangerButton" data-delete-admin-key="${key.id}">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No API keys found.</td></tr>';
  document.querySelectorAll('[data-delete-admin-key]').forEach(button => button.addEventListener('click', () => adminDeleteKey(Number(button.dataset.deleteAdminKey))));
}

async function adminCreateUser() {
  errorBox.hidden = true;
  try {
    await postAuthJson('/web/admin/users', {
      username: document.querySelector('#adminNewUsername').value.trim(),
      display_name: document.querySelector('#adminNewName').value.trim(),
      password: document.querySelector('#adminNewPassword').value,
      role: document.querySelector('#adminNewRole').value,
    });
    document.querySelector('#adminNewUsername').value = '';
    document.querySelector('#adminNewName').value = '';
    document.querySelector('#adminNewPassword').value = '';
    await refreshAdmin();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function adminCreateKey() {
  errorBox.hidden = true;
  try {
    const result = await postAuthJson('/web/admin/api-keys', {
      user_id: Number(document.querySelector('#adminKeyUser').value),
      label: document.querySelector('#adminKeyLabel').value.trim(),
    });
    const secretCard = document.querySelector('#adminSecretCard');
    secretCard.innerHTML = `New API key. Copy it now; it will not be shown again.<code>${escapeHtml(result.secret)}</code>`;
    secretCard.hidden = false;
    document.querySelector('#adminKeyLabel').value = '';
    await refreshAdmin();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function adminToggleUser(userId) {
  const user = adminState.users.find(item => item.id === userId);
  if (!user) return;
  try {
    await postAuthJson('/web/admin/users/update', { id: user.id, username: user.username, display_name: user.display_name, role: user.role, enabled: !user.enabled, password: null });
    await refreshAdmin();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function adminDeleteUser(userId) {
  if (!confirm('Delete this user?')) return;
  try {
    await postAuthJson('/web/admin/users/delete', { user_id: userId });
    await refreshAdmin();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

async function adminDeleteKey(keyId) {
  if (!confirm('Delete this API key?')) return;
  try {
    await postAuthJson('/web/admin/api-keys/delete', { key_id: keyId });
    await refreshAdmin();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

function renderModels(items) {
  const root = document.querySelector('#models');
  if (!items.length) { root.innerHTML = '<tr><td colspan="6" class="muted">No model usage yet.</td></tr>'; return; }
  root.innerHTML = items.map(item => `<tr><td><code>${escapeHtml(item.model)}</code></td><td><span class="adminBadge" style="color:#8ce99a">Local</span></td><td>${item.requests.toLocaleString()}</td><td>${(item.input_tokens || 0).toLocaleString()}</td><td>${(item.output_tokens || 0).toLocaleString()}</td><td>${((item.input_tokens || 0) + (item.output_tokens || 0)).toLocaleString()}</td></tr>`).join('');
}

function downloadOverviewCsv() {
  if (!overviewExportData) return;
  const { summary, displayDailyUsage } = overviewExportData;
  const totalTokens = Number(summary.input_tokens || 0) + Number(summary.output_tokens || 0);
  const csv = [
    ['Summary'],
    ['Scope', dashboardState.scope],
    ['Range', rangeLabel(dashboardState.range, dashboardState.startTs, dashboardState.endTs)],
    ['Total requests', summary.request_count],
    ['Input tokens', summary.input_tokens],
    ['Output tokens', summary.output_tokens],
    ['Total tokens', totalTokens],
    [],
    ['Daily usage'],
    ['Date', 'Requests', 'Input tokens', 'Output tokens', 'Total tokens'],
    ...displayDailyUsage.map(point => [point.day, point.requests, point.input_tokens, point.output_tokens, point.total_tokens]),
    [],
    ['Model breakdown'],
    ['Model', 'Provider', 'Requests', 'Input tokens', 'Output tokens', 'Total tokens'],
    ...(summary.model_usage || []).map(item => [item.model, 'Local', item.requests, item.input_tokens, item.output_tokens, Number(item.input_tokens || 0) + Number(item.output_tokens || 0)]),
  ].map(csvRow).join('\n');
  downloadTextFile(`llmeter-overview-${dateKey(new Date())}.csv`, csv, 'text/csv;charset=utf-8');
}

function renderSpark(selector, values, tone) {
  const root = document.querySelector(selector);
  const width = 260, height = 58, pad = 10;
  const safe = values.length ? values : [0];
  const max = Math.max(1, ...safe);
  const xFor = index => pad + (safe.length <= 1 ? width - pad * 2 : (index / (safe.length - 1)) * (width - pad * 2));
  const yFor = value => height - pad - (value / max) * (height - pad * 2);
  const path = safe.length === 1 ? `M ${pad} ${yFor(safe[0])} L ${width - pad} ${yFor(safe[0])}` : safe.map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(value)}`).join(' ');
  const lastX = xFor(safe.length - 1), lastY = yFor(safe[safe.length - 1]);
  root.innerHTML = `<svg class="metricSparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path class="spark-${tone}" d="${path}"></path><circle class="spark-${tone}" cx="${lastX}" cy="${lastY}" r="5"></circle></svg>`;
}

function renderDailyModelChart(points, displayDays = []) {
  const root = document.querySelector('#dailyModelChart');
  const days = displayDays.length ? displayDays : [...new Set(points.map(point => point.day))];
  if (!days.length) { root.innerHTML = '<p>No token usage yet.</p>'; return; }
  const width = 760, height = 350;
  const padding = { top: 24, right: 20, bottom: 70, left: 58 };
  const models = [...new Set(points.map(point => point.model))];
  const visible = models.filter(model => !hiddenChartModels.has(model));
  const totals = new Map();
  for (const point of points) if (!hiddenChartModels.has(point.model)) totals.set(point.day, (totals.get(point.day) || 0) + point.total_tokens);
  const max = Math.max(1, ...totals.values());
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const groupWidth = days.length ? plotWidth / days.length : plotWidth;
  const barWidth = Math.max(8, Math.min(28, groupWidth * .58));
  const yFor = value => padding.top + plotHeight - (value / max) * plotHeight;
  const colorFor = model => modelChartColors[Math.max(0, models.indexOf(model)) % modelChartColors.length];
  const valueFor = (day, model) => (points.find(point => point.day === day && point.model === model) || { total_tokens: 0 }).total_tokens;
  let svg = `<svg viewBox="0 0 ${width} ${height}" class="modelTokenChart" role="img" aria-label="Daily token usage by model">`;
  for (const ratio of [0,.25,.5,.75,1]) {
    const y = padding.top + plotHeight - ratio * plotHeight;
    svg += `<g><line x1="${padding.left}" x2="${width - padding.right}" y1="${y}" y2="${y}" class="chartGrid"></line><text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" class="chartAxisText">${formatCompact(Math.round(max * ratio))}</text></g>`;
  }
  days.forEach((day, dayIndex) => {
    let stacked = 0;
    const x = padding.left + dayIndex * groupWidth + (groupWidth - barWidth) / 2;
    visible.forEach(model => {
      const value = valueFor(day, model);
      if (value <= 0) return;
      const yTop = yFor(stacked + value);
      const yBottom = yFor(stacked);
      stacked += value;
      svg += `<rect x="${x}" y="${yTop}" width="${barWidth}" height="${Math.max(2, yBottom - yTop)}" rx="4" fill="${colorFor(model)}" opacity=".88" data-chart-day="${escapeHtml(day)}"></rect>`;
    });
    if (stacked <= 0) {
      svg += `<rect x="${x}" y="${yFor(0) - 3}" width="${barWidth}" height="3" rx="2" class="zeroUsageBar" data-chart-day="${escapeHtml(day)}"></rect>`;
    }
    svg += `<text x="${x + barWidth / 2}" y="${height - 36}" text-anchor="middle" class="chartAxisText">${shortDate(day)}</text>`;
  });
  svg += `<text x="${padding.left + plotWidth / 2}" y="${height - 10}" text-anchor="middle" class="chartAxisTitle">Date</text>`;
  svg += '</svg>';
  const tooltip = '<div id="webChartTooltip" class="webChartTooltip" hidden></div>';
  const legend = `<div class="modelLegend">${models.slice(0,10).map(model => `<button class="${hiddenChartModels.has(model) ? 'inactive' : ''}" data-model="${escapeHtml(model)}"><span class="legendDot" style="background:${colorFor(model)}"></span>${escapeHtml(model)}</button>`).join('')}</div>`;
  root.innerHTML = svg + tooltip + legend;
  const tooltipEl = root.querySelector('#webChartTooltip');
  root.querySelectorAll('[data-chart-day]').forEach(bar => {
    bar.addEventListener('mouseenter', event => showChartTooltip(event, bar.dataset.chartDay, points, visible, colorFor, valueFor));
    bar.addEventListener('mousemove', event => moveChartTooltip(event));
    bar.addEventListener('mouseleave', () => { tooltipEl.hidden = true; });
  });
  root.querySelectorAll('[data-model]').forEach(button => button.addEventListener('click', () => {
    const model = button.dataset.model;
    hiddenChartModels.has(model) ? hiddenChartModels.delete(model) : hiddenChartModels.add(model);
    renderDailyModelChart(points, days);
  }));
}

function showChartTooltip(event, day, points, visible, colorFor, valueFor) {
  const tooltip = document.querySelector('#webChartTooltip');
  if (!tooltip || !day) return;
  const rows = visible.map(model => ({ model, tokens: valueFor(day, model), color: colorFor(model) })).filter(row => row.tokens > 0);
  tooltip.innerHTML = `<h3>${escapeHtml(day)}</h3>${rows.map(row => `<p><span style="background:${row.color}"></span><b style="color:${row.color}">${escapeHtml(row.model)}</b><strong>${row.tokens.toLocaleString()}</strong></p>`).join('')}`;
  tooltip.hidden = false;
  moveChartTooltip(event);
}

function moveChartTooltip(event) {
  const tooltip = document.querySelector('#webChartTooltip');
  const chart = document.querySelector('#dailyModelChart');
  if (!tooltip || !chart) return;
  const bounds = chart.getBoundingClientRect();
  const x = Math.min(bounds.width - 24, Math.max(24, event.clientX - bounds.left));
  const y = Math.min(bounds.height - 24, Math.max(78, event.clientY - bounds.top));
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function renderLogs(items) {
  logsState.items = items;
  logsState.page = 0;
  renderLogsPage();
}

function renderLogColumnToggles() {
  const root = document.querySelector('#logColumnToggles');
  root.innerHTML = logColumns.map(([key, label]) => `<label><input type="checkbox" data-log-column="${key}" ${visibleLogColumns.has(key) ? 'checked' : ''}>${label}</label>`).join('');
  root.querySelectorAll('[data-log-column]').forEach(input => input.addEventListener('change', () => {
    input.checked ? visibleLogColumns.add(input.dataset.logColumn) : visibleLogColumns.delete(input.dataset.logColumn);
    renderLogsPage();
  }));
}

function logCell(column, item, index) {
  if (column === 'time') return new Date(item.created_at * 1000).toLocaleString();
  if (column === 'userId') return escapeHtml(item.display_name || '-');
  if (column === 'username') return escapeHtml(item.username || '-');
  if (column === 'endpoint') return `<code>${escapeHtml(item.endpoint)}</code>`;
  if (column === 'model') return escapeHtml(item.model || '-');
  if (column === 'key') return escapeHtml(item.api_key_prefix || '-');
  if (column === 'input') return Number(item.input_tokens || 0).toLocaleString();
  if (column === 'output') return Number(item.output_tokens || 0).toLocaleString();
  if (column === 'status') return item.status_code;
  if (column === 'details') return `<button class="ghostButton" data-log-index="${index}">View</button>`;
  return '';
}

function renderLogsPage() {
  const totalPages = Math.max(1, Math.ceil(logsState.items.length / logsState.shown));
  logsState.page = Math.min(logsState.page, totalPages - 1);
  const start = logsState.page * logsState.shown;
  const pageItems = logsState.items.slice(start, start + logsState.shown);
  document.querySelector('#logsPage').textContent = `Page ${logsState.page + 1} / ${totalPages}`;
  document.querySelector('#logsPrev').disabled = logsState.page <= 0;
  document.querySelector('#logsNext').disabled = logsState.page >= totalPages - 1;
  const activeColumns = logColumns.filter(([key]) => visibleLogColumns.has(key));
  document.querySelector('#logsHead').innerHTML = `<tr>${activeColumns.map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
  document.querySelector('#logs').innerHTML = pageItems.length
    ? pageItems.map((item, index) => `<tr>${activeColumns.map(([key]) => `<td>${logCell(key, item, start + index)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${Math.max(1, activeColumns.length)}" class="muted">No logs found.</td></tr>`;
  document.querySelectorAll('[data-log-index]').forEach(button => button.addEventListener('click', () => openLogModal(logsState.items[Number(button.dataset.logIndex)])));
}

function openLogModal(item) {
  if (!item) return;
  document.querySelector('#logDetail').innerHTML = `
    <div class="detailBlock"><span>Metadata</span><pre>Time: ${new Date(item.created_at * 1000).toLocaleString()}\nUser: ${escapeHtml(item.display_name || '-')}\nUsername: ${escapeHtml(item.username || '-')}\nEndpoint: ${escapeHtml(item.endpoint)}\nModel: ${escapeHtml(item.model || '-')}\nKey: ${escapeHtml(item.api_key_prefix || '-')}\nInput tokens: ${Number(item.input_tokens || 0).toLocaleString()}\nOutput tokens: ${Number(item.output_tokens || 0).toLocaleString()}</pre></div>
    <div class="detailBlock"><span>Request</span><pre>${escapeHtml(item.input_text || '')}</pre></div>
    <div class="detailBlock"><span>Response</span><pre>${escapeHtml(item.output_text || '')}</pre></div>
    <div class="detailBlock"><span>Usage</span><pre>Input tokens: ${Number(item.input_tokens || 0).toLocaleString()}\nOutput tokens: ${Number(item.output_tokens || 0).toLocaleString()}\nStatus: ${item.status_code}${item.error_message ? `\nError: ${escapeHtml(item.error_message)}` : ''}</pre></div>
  `;
  document.querySelector('#logModal').hidden = false;
}

function closeLogModal() {
  document.querySelector('#logModal').hidden = true;
}

function renderProfileKeysPage() {
  const totalPages = Math.max(1, Math.ceil(profileKeysState.items.length / profileKeysState.shown));
  profileKeysState.page = Math.min(profileKeysState.page, totalPages - 1);
  const start = profileKeysState.page * profileKeysState.shown;
  const pageItems = profileKeysState.items.slice(start, start + profileKeysState.shown);
  document.querySelector('#profileKeysPage').textContent = `Page ${profileKeysState.page + 1} / ${totalPages}`;
  document.querySelector('#profileKeysPrev').disabled = profileKeysState.page <= 0;
  document.querySelector('#profileKeysNext').disabled = profileKeysState.page >= totalPages - 1;
  document.querySelector('#profileKeys').innerHTML = pageItems.length
    ? pageItems.map(key => `<tr><td>${escapeHtml(key.label)}</td><td><code>${escapeHtml(key.key_prefix)}</code></td><td><button class="dangerButton" data-delete-key="${key.id}">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No API keys yet.</td></tr>';
  document.querySelectorAll('[data-delete-key]').forEach(button => button.addEventListener('click', () => deleteProfileKey(Number(button.dataset.deleteKey))));
}

function openKeyModal() {
  document.querySelector('#keyDescription').value = '';
  document.querySelector('#createdKeySecret').hidden = true;
  document.querySelector('#createdKeySecret').innerHTML = '';
  document.querySelector('#keyModal').hidden = false;
}

function closeKeyModal() {
  document.querySelector('#keyModal').hidden = true;
}

async function createProfileKey() {
  try {
    const label = document.querySelector('#keyDescription').value.trim();
    const result = await postAuthJson('/web/api-keys', { label });
    const secretCard = document.querySelector('#profileSecretCard');
    secretCard.innerHTML = `New API key. Copy it now; it will not be shown again.<code>${escapeHtml(result.secret)}</code>`;
    secretCard.hidden = false;
    closeKeyModal();
    await refreshProfile();
  } catch (error) {
    document.querySelector('#createdKeySecret').textContent = error.message;
    document.querySelector('#createdKeySecret').hidden = false;
  }
}

async function deleteProfileKey(keyId) {
  if (!confirm('Delete this API key?')) return;
  try {
    await postAuthJson('/web/api-keys/delete', { key_id: keyId });
    await refreshProfile();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

function showAuthError(message) {
  authError.textContent = message;
  authError.hidden = false;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function downloadTextFile(filename, content, mimeType) {
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

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function parseDayKey(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(date)
    ? new Date(year, month - 1, date)
    : null;
}

function dashboardDateRange(startTs, endTs, existingDays) {
  const sortedExisting = [...new Set(existingDays)].sort();
  if (startTs === null && endTs === null) return sortedExisting;
  const now = new Date();
  const firstExisting = sortedExisting[0] ? parseDayKey(sortedExisting[0]) : null;
  const end = endTs !== null ? new Date(endTs * 1000) : now;
  const start = startTs !== null ? new Date(startTs * 1000) : (firstExisting || end);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const days = [];
  while (cursor <= last) {
    days.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function fillDailyUsageRange(points, startTs, endTs) {
  const byDay = new Map(points.map(point => [point.day, point]));
  return dashboardDateRange(startTs, endTs, points.map(point => point.day)).map(day => byDay.get(day) || {
    day,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  });
}

function formatCompact(value) {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function shortDate(day) {
  const parts = String(day).split('-');
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day;
}

function formatHeroDate(day) {
  const parsed = parseDayKey(day);
  return parsed ? parsed.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) : day;
}

function rangeLabel(range, startTs, endTs) {
  if (range === 'today') return 'Today';
  if (range === '7d') return 'Last 7 days';
  if (range === '30d') return 'Last 30 days';
  if (range === 'custom') {
    const start = startTs ? dateKey(new Date(startTs * 1000)) : '';
    const end = endTs ? dateKey(new Date(endTs * 1000)) : '';
    if (start && end) return `${start} to ${end}`;
    if (start) return `From ${start}`;
    if (end) return `Until ${end}`;
    return 'Custom range';
  }
  return 'All time';
}
