import { Button, Card, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import React, { useState } from 'react';

import { ErrorCard } from '../components/common';

export const PASSWORD_RULES = [
  { label: '12+ chars', test: (p: string) => p.length >= 12 },
  { label: 'Uppercase', test: (p: string) => /[A-Z]/.test(p) },
  { label: 'Lowercase', test: (p: string) => /[a-z]/.test(p) },
  { label: 'Number', test: (p: string) => /[0-9]/.test(p) },
  { label: 'Symbol', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

export function PasswordRules({ password }: { password: string }) {
  return (
    <div className="passwordRules">
      {PASSWORD_RULES.map(rule => (
        <span key={rule.label} className={rule.test(password) ? 'passwordRule met' : 'passwordRule'}>
          {rule.test(password) ? '✓ ' : ''}{rule.label}
        </span>
      ))}
    </div>
  );
}

export function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <div className="authPage"><Card withBorder className="authCard"><Stack><div><Title>{title}</Title>{subtitle ? <Text c="dimmed">{subtitle}</Text> : null}</div>{children}</Stack></Card></div>;
}

export function SetupScreen({ onSetup }: { onSetup: (username: string, displayName: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('root');
  const [displayName, setDisplayName] = useState('Root Admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try { await onSetup(username, displayName, password); } catch (err) { setError(String(err)); }
  };
  return <AuthFrame title="Create root admin" subtitle="First setup for Local Large Model Meter">
    {error ? <ErrorCard message={error} /> : null}
    <TextInput label="Root admin username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
    <TextInput label="True name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
    <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
    <PasswordRules password={password} />
    <Button onClick={submit} disabled={!username.trim() || !password}>Create root admin</Button>
    <Text ta="center" c="dimmed">Create this account before using the application.</Text>
  </AuthFrame>;
}

export function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try { await onLogin(username, password); } catch (err) { setError(String(err)); }
  };
  return <AuthFrame title="Local Large Model Meter">
    {error ? <ErrorCard message={error} /> : null}
    <TextInput label="Username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
    <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
    <Button onClick={submit} disabled={!username.trim() || !password}>Log in</Button>
    <Text ta="center" c="dimmed">No account? Ask an admin to create one</Text>
  </AuthFrame>;
}
