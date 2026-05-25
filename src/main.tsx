import '@mantine/core/styles.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles/index.css';

import { invoke } from '@tauri-apps/api/core';
import {
  Badge,
  Container,
  MantineProvider,
  Text,
} from '@mantine/core';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type {
  LoginResult,
  Page,
  ServerStatus,
  UserAccount,
} from './types';
import { pageLabels } from './constants';
import { ErrorCard } from './components/common';
import { useAsyncData } from './hooks/useAsyncData';
import { AuthFrame, LoginScreen, SetupScreen } from './pages/Auth';
import { ChatPage } from './pages/Chat';
import { DashboardPage } from './pages/Dashboard';
import { LogsPage } from './pages/Logs';
import { ModelsPage } from './pages/Models';
import { AdminPage } from './pages/Admin';
import { ProfilePage } from './pages/Profile';
import { ApplicationSettingsPage } from './pages/Settings';

const navPageIcons: Record<Page, string> = {
  dashboard: 'bi-bar-chart-line',
  chat: 'bi-chat-dots',
  models: 'bi-cpu',
  logs: 'bi-terminal',
  admin: 'bi-people',
  profile: 'bi-person-circle',
  settings: 'bi-gear',
};

function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [error, setError] = useState<string | null>(null);

  const refreshSetupState = async () => {
    const state = await invoke<{ needs_setup: boolean }>('get_setup_state');
    setNeedsSetup(state.needs_setup);
  };

  useEffect(() => { void refreshSetupState().catch((err) => setError(String(err))); }, []);

  const login = async (username: string, password: string) => {
    const result = await invoke<LoginResult>('login', { input: { username, password } });
    setCurrentUser(result.user);
    setPage('dashboard');
  };

  const setup = async (username: string, displayName: string, password: string) => {
    const user = await invoke<UserAccount>('setup_admin', { input: { username, display_name: displayName, password } });
    setCurrentUser(user);
    setNeedsSetup(false);
    setPage('dashboard');
  };

  return (
    <MantineProvider defaultColorScheme="dark">
      {needsSetup === null ? <AuthFrame title="LLMeter"><Text>Loading...</Text>{error ? <ErrorCard message={error} /> : null}</AuthFrame> : null}
      {needsSetup === true ? <SetupScreen onSetup={setup} /> : null}
      {needsSetup === false && !currentUser ? <LoginScreen onLogin={login} /> : null}
      {currentUser ? <Shell currentUser={currentUser} page={page} setPage={setPage} onLogout={() => setCurrentUser(null)} onUpdateUser={setCurrentUser} /> : null}
    </MantineProvider>
  );
}

function Shell({ currentUser, page, setPage, onLogout, onUpdateUser }: { currentUser: UserAccount; page: Page; setPage: (page: Page) => void; onLogout: () => void; onUpdateUser: (u: UserAccount) => void }) {
  const mainNavPages: Page[] = ['chat', 'models', 'dashboard', 'logs', ...(currentUser.role === 'admin' ? ['admin' as Page] : [])];
  const [collapsed, setCollapsed] = useState(false);
  const serverStatus = useAsyncData<ServerStatus>(
    () => invoke('get_public_server_status'),
    [],
  );
  useEffect(() => {
    const id = setInterval(() => { void serverStatus.reload(); }, 5000);
    return () => clearInterval(id);
  }, [serverStatus.reload]);
  const isRunning = serverStatus.data?.state === 'running';
  const dotClass = isRunning ? 'statusDot' : 'statusDot statusDot--red';
  return (
    <div className="appRoot">
      <nav className={collapsed ? 'navSidebar collapsed' : 'navSidebar'}>
        <div className="navSidebarTop">
          <span className="navBrandText">LLMeter</span>
          <button className="navCollapseBtn" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <i className={`bi ${collapsed ? 'bi-layout-sidebar' : 'bi-layout-sidebar-reverse'}`} />
          </button>
        </div>
        <div className="navMain">
          {mainNavPages.map((key) => {
            const label = pageLabels.find(([k]) => k === key)?.[1] ?? key;
            return (
              <button key={key} className={page === key ? 'navItem active' : 'navItem'} onClick={() => setPage(key)} title={collapsed ? label : undefined}>
                <i className={`bi ${navPageIcons[key]}`} />
                <span className="navItemLabel">{label}</span>
              </button>
            );
          })}
        </div>
        <div className="navSidebarBottom">
          <div className="navStatusRow">
            <span className={dotClass} />
            <Text size="xs" c={isRunning ? 'green' : 'red'}>{isRunning ? 'Running' : 'Stopped'}</Text>
          </div>
          {currentUser.role === 'admin' && (
            <button className={page === 'settings' ? 'navItem active' : 'navItem'} onClick={() => setPage('settings')} title={collapsed ? 'Settings' : undefined}>
              <i className="bi bi-gear" />
              <span className="navItemLabel">Settings</span>
            </button>
          )}
          <button className={page === 'profile' ? 'navItem active' : 'navItem'} onClick={() => setPage('profile')} title={collapsed ? currentUser.display_name : undefined}>
            <i className="bi bi-person-circle" />
            <span className="navItemLabel" style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{currentUser.display_name}</span>
            {currentUser.role === 'admin' && <Badge size="xs" color="orange" variant="light" style={{ flexShrink: 0 }}>Admin</Badge>}
          </button>
          <button className="navItem" onClick={onLogout} title={collapsed ? 'Log out' : undefined}>
            <i className="bi bi-box-arrow-right" />
            <span className="navItemLabel">Log out</span>
          </button>
        </div>
      </nav>
      <div className="appMain">
        {/* Chat stays mounted so its state persists when switching tabs */}
        <div className={page === 'chat' ? 'fullPageWrapper' : 'fullPageWrapper hidden'}>
          <ChatPage currentUser={currentUser} />
        </div>
        {/* Models/Logs/Admin fill full height with internal scroll */}
        {(page === 'models' || page === 'logs' || page === 'admin') && (
          <div className="scrollPageWrapper">
            <PageView page={page} currentUser={currentUser} setPage={setPage} onUpdateUser={onUpdateUser} serverStatus={serverStatus.data} setServerStatus={serverStatus.setData} reloadServerStatus={serverStatus.reload} />
          </div>
        )}
        {/* Dashboard/Profile/Settings use padded container */}
        {page !== 'chat' && page !== 'models' && page !== 'logs' && page !== 'admin' && (
          <Container fluid className="contentShell">
            <PageView page={page} currentUser={currentUser} setPage={setPage} onUpdateUser={onUpdateUser} serverStatus={serverStatus.data} setServerStatus={serverStatus.setData} reloadServerStatus={serverStatus.reload} />
          </Container>
        )}
      </div>
    </div>
  );
}

function PageView({ page, currentUser, setPage, onUpdateUser, serverStatus, setServerStatus, reloadServerStatus }: { page: Page; currentUser: UserAccount; setPage: (p: Page) => void; onUpdateUser: (u: UserAccount) => void; serverStatus: ServerStatus | null; setServerStatus: React.Dispatch<React.SetStateAction<ServerStatus | null>>; reloadServerStatus: () => Promise<void> }) {
  if (page === 'models') return <ModelsPage currentUser={currentUser} serverStatus={serverStatus} setServerStatus={setServerStatus} reloadServerStatus={reloadServerStatus} />;
  if (page === 'logs') return <LogsPage currentUser={currentUser} />;
  if (page === 'admin') return currentUser.role === 'admin' ? <AdminPage currentUser={currentUser} /> : <ErrorCard message="Admin access required." />;
  if (page === 'profile') return <ProfilePage currentUser={currentUser} onUpdateUser={onUpdateUser} />;
  if (page === 'settings') return currentUser.role === 'admin' ? <ApplicationSettingsPage currentUser={currentUser} /> : <ErrorCard message="Admin access required." />;
  return <DashboardPage currentUser={currentUser} />;
}

createRoot(document.getElementById('root')!).render(<App />);
