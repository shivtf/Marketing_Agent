'use client';
// Admin page: create employee accounts (default password, forced change at first login) and reset passwords.
import { useCallback, useEffect, useState } from 'react';
import { CardHead, DataTable, Badge } from './ui';
import * as admin from '@/core/admin';

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString() : 'Never');

export default function UsersView() {
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error' | 'forbidden'
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setUsers(await admin.listUsers());
      setStatus('ready');
    } catch (err) {
      setStatus(err.status === 403 ? 'forbidden' : 'error');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const { name, email } = Object.fromEntries(new FormData(form));
    setBusy(true);
    setMsg({ text: '', tone: 'error' });
    try {
      const u = await admin.createUser(name, email);
      form.reset();
      setMsg({ text: `Created ${u.email}. They sign in with the default employee password and must change it at first login.`, tone: 'ok' });
      await load();
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function onReset(u) {
    if (!window.confirm(`Reset ${u.email} to the default password? They must change it at next login.`)) return;
    setMsg({ text: '', tone: 'error' });
    try {
      await admin.resetUserPassword(u.id);
      setMsg({ text: `${u.email} was reset to the default password.`, tone: 'ok' });
      await load();
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    }
  }

  if (status === 'forbidden') {
    return (
      <main className="page">
        <div className="page-head">
          <h1 className="page-title">Users</h1>
          <p className="muted">Only admins can manage users.</p>
        </div>
      </main>
    );
  }

  const rows = users.map((u) => (
    <tr key={u.id}>
      <td>{u.name || '—'}</td>
      <td>{u.email}</td>
      <td>{u.role === 'admin' ? <Badge text="Admin" tone="gray" /> : 'Employee'}</td>
      <td>{u.mustChangePassword ? <Badge text="Default password" tone="amber" /> : <span className="muted">Set</span>}</td>
      <td>{fmt(u.lastSignInAt)}</td>
      <td><button className="btn" type="button" onClick={() => onReset(u)}>Reset password</button></td>
    </tr>
  ));

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">Users</h1>
        <p className="muted">
          Create employee accounts. New accounts get the default password and must change it at first login.
        </p>
      </div>
      <section className="card">
        <CardHead icon="users" title="Add employee" />
        <form className="user-form" noValidate onSubmit={onCreate}>
          <label className="field"><span>Name</span><input name="name" type="text" autoComplete="off" required /></label>
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" autoComplete="off" placeholder="employee@company.com" required />
          </label>
          <button className={`btn primary auth-submit${busy ? ' loading' : ''}`} type="submit" disabled={busy}>Create user</button>
        </form>
        <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>
      </section>
      <section className="card">
        <CardHead icon="users" title="All users" />
        <DataTable
          status={status} what="users" onRetry={load} rows={rows} emptyIcon="users" emptyText="No users yet."
          head={['Name', 'Email', 'Role', 'Password', 'Last sign-in', ''].map((h, i) => <th key={i}>{h}</th>)}
        />
      </section>
    </main>
  );
}
