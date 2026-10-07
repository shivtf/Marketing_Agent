'use client';
// Admin page: create employee accounts with a password the admin chooses, set new passwords, make employees admins
// (or back), and remove accounts from the dashboard (they stay in Supabase). Employees can change their password from Profile.
import { useCallback, useEffect, useState } from 'react';
import { CardHead, DataTable, Badge } from './ui';
import { Icon } from './Icon';
import * as admin from '@/core/admin';
import { getSession } from '@/core/auth';
import { useConfirm } from './ConfirmDialog';

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString() : 'Never');

export default function UsersView() {
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error' | 'forbidden'
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const [meId, setMeId] = useState(null);
  const [removing, setRemoving] = useState(null); // id of the user being removed
  const [changingRole, setChangingRole] = useState(null); // id of the user whose role is being changed
  const [confirmDialog, confirm] = useConfirm();
  const [showPw, setShowPw] = useState(false);

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
  useEffect(() => { getSession().then((s) => setMeId(s?.user.id ?? null)); }, []);

  // Success messages clear themselves after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (msg.tone !== 'ok' || !msg.text) return undefined;
    const t = setTimeout(() => setMsg({ text: '', tone: 'error' }), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  async function onCreate(e) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const { name, email, password } = Object.fromEntries(new FormData(form));
    setBusy(true);
    setMsg({ text: '', tone: 'error' });
    try {
      const u = await admin.createUser(name, email, password);
      form.reset();
      setShowPw(false);
      setMsg({ text: `Created ${u.email}. Share the password with them; they can change it later from Profile.`, tone: 'ok' });
      await load();
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function onReset(u) {
    const password = await confirm({
      title: 'Set a new password',
      message: `Choose a new password for ${u.email} and share it with them.`,
      confirmLabel: 'Save password',
      field: { label: 'New password' },
    });
    if (!password) return;
    setMsg({ text: '', tone: 'error' });
    try {
      await admin.setUserPassword(u.id, password);
      setMsg({ text: `New password saved for ${u.email}.`, tone: 'ok' });
      await load();
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    }
  }

  async function onToggleAdmin(u) {
    const promote = u.role !== 'admin';
    const who = u.name || u.email;
    const ok = await confirm({
      title: promote ? `Make ${who} an admin?` : `Remove admin rights from ${who}?`,
      message: promote
        ? `${u.email} will be able to add, reset and remove users, and change their roles.`
        : `${u.email} will become an employee and lose access to user management.`,
      confirmLabel: promote ? 'Make admin' : 'Remove admin',
      danger: !promote,
    });
    if (!ok) return;
    setMsg({ text: '', tone: 'error' });
    setChangingRole(u.id);
    try {
      const updated = await admin.setUserRole(u.id, promote ? 'admin' : 'employee');
      setUsers((list) => list.map((x) => (x.id === u.id ? updated : x)));
      // The server checks the role on every call, so it applies at once; the Users tab follows their session
      // token, which refreshes within the hour (or on their next sign-in).
      setMsg({ text: `${u.email} is now ${promote ? 'an admin' : 'an employee'}.`, tone: 'ok' });
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setChangingRole(null);
    }
  }

  async function onRemove(u) {
    const ok = await confirm({
      title: `Remove ${u.name || 'this user'}?`,
      message: `${u.email} will be removed from the dashboard and will no longer be able to sign in.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setMsg({ text: '', tone: 'error' });
    setRemoving(u.id);
    try {
      await admin.removeUser(u.id);
      setUsers((list) => list.filter((x) => x.id !== u.id));
      setMsg({ text: `${u.email} was removed.`, tone: 'ok' });
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setRemoving(null);
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
      <td>{fmt(u.lastSignInAt)}</td>
      <td>
        {u.id === meId ? <span className="muted small">You</span> : (
          <div className="user-actions">
            <button className="btn" type="button" disabled={changingRole === u.id} onClick={() => onToggleAdmin(u)}>
              {changingRole === u.id ? 'Saving…' : u.role === 'admin' ? 'Remove admin' : 'Make admin'}
            </button>
            <button className="btn" type="button" onClick={() => onReset(u)}>Reset password</button>
            <button className="btn danger" type="button" disabled={removing === u.id} onClick={() => onRemove(u)}>
              {removing === u.id ? 'Removing…' : 'Remove'}
            </button>
          </div>
        )}
      </td>
    </tr>
  ));

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">Users</h1>
        <p className="muted">
          Create employee accounts and choose their password. They can change it any time from their Profile.
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
          <label className="field">
            <span>Password</span>
            <span className="pw-wrap">
              <input
                name="password"
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                minLength={8}
                required
              />
              <button
                className="pw-toggle"
                type="button"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                aria-pressed={showPw}
                onClick={() => setShowPw(!showPw)}
              >
                <Icon name="eye" />
              </button>
            </span>
          </label>
          <button className={`btn primary auth-submit${busy ? ' loading' : ''}`} type="submit" disabled={busy}>Create user</button>
        </form>
        <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>
      </section>
      <section className="card">
        <CardHead icon="users" title="All users" />
        <DataTable
          status={status} what="users" onRetry={load} rows={rows} emptyIcon="users" emptyText="No users yet."
          head={['Name', 'Email', 'Role', 'Last sign-in', ''].map((h, i) => <th key={i}>{h}</th>)}
        />
      </section>
      {confirmDialog}
    </main>
  );
}
