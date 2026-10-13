'use client';
// Admin page: create employee accounts with a password the admin chooses, set new passwords, make employees admins
// (or back), and remove accounts from the dashboard (they stay in Supabase, listed under Removed users, and can be
// restored). Employees can change their password from Profile. A password reset or a removal also signs the person
// out on every device (backend /admin/users/{id}/end-sessions): Supabase would otherwise keep them signed in.
import { useCallback, useEffect, useState } from 'react';
import { CardHead, DataTable, Badge } from './ui';
import { Icon } from './Icon';
import * as admin from '@/core/admin';
import { endUserSessions } from '@/core/api';
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
  const [restoring, setRestoring] = useState(null); // id of the user being restored
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
      if (err.status === 409 && err.data?.removedId) {
        setBusy(false);
        await onRestore({ id: err.data.removedId, email: String(email).trim().toLowerCase() }, form);
        return;
      }
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // Signs the user out on every device. -> '' when done, or why it failed (the main action already succeeded).
  async function signOutEverywhere(u) {
    try {
      await endUserSessions(u.id);
      return '';
    } catch (err) {
      return err.message;
    }
  }

  // A removed account back on the dashboard, as an employee. `form`: the Add employee form, cleared on success when
  // the restore was offered from it (the email belonged to a removed account).
  async function onRestore(u, form) {
    const ok = await confirm({
      title: `Restore ${u.name || u.email}?`,
      message: form
        ? `${u.email} belongs to a removed account. Restore it instead? It comes back as an employee, with its old password; use Reset password to give them a new one.`
        : `${u.email} will be able to sign in again, as an employee, with their old password. Use Reset password to give them a new one.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setMsg({ text: '', tone: 'error' });
    setRestoring(u.id);
    try {
      const updated = await admin.restoreUser(u.id);
      setUsers((list) => (list.some((x) => x.id === u.id) ? list.map((x) => (x.id === u.id ? updated : x)) : [...list, updated]));
      form?.reset();
      setMsg({ text: `${u.email} is restored as an employee. Reset their password if they shouldn't use the old one.`, tone: 'ok' });
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setRestoring(null);
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
      const problem = await signOutEverywhere(u);
      setMsg(problem
        ? { text: `New password saved for ${u.email}, but they are still signed in where they were: ${problem}`, tone: 'error' }
        : { text: `New password saved for ${u.email}. They were signed out on every device.`, tone: 'ok' });
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

  // An account without a dashboard role (e.g. made before roles were saved on creation) can't use the dashboard.
  async function onGiveAccess(u) {
    const ok = await confirm({
      title: `Give ${u.name || u.email} access?`,
      message: `${u.email} will be able to use the dashboard as an employee.`,
      confirmLabel: 'Give access',
    });
    if (!ok) return;
    setMsg({ text: '', tone: 'error' });
    setChangingRole(u.id);
    try {
      const updated = await admin.setUserRole(u.id, 'employee');
      setUsers((list) => list.map((x) => (x.id === u.id ? updated : x)));
      setMsg({ text: `${u.email} can now use the dashboard.`, tone: 'ok' });
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
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, removed: true } : x)));
      // Already locked out (banned, and both servers check removal on every call); this also ends their sessions.
      const problem = await signOutEverywhere(u);
      setMsg(problem
        ? { text: `${u.email} was removed (they can no longer use the dashboard), but their sessions could not be ended: ${problem}`, tone: 'error' }
        : { text: `${u.email} was removed and signed out on every device.`, tone: 'ok' });
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

  const removedUsers = users.filter((u) => u.removed);
  const removedRows = removedUsers.map((u) => (
    <tr key={u.id}>
      <td>{u.name || '—'}</td>
      <td>{u.email}</td>
      <td>{fmt(u.lastSignInAt)}</td>
      <td>
        <div className="user-actions">
          <button className="btn" type="button" disabled={restoring === u.id} onClick={() => onRestore(u)}>
            {restoring === u.id ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      </td>
    </tr>
  ));

  const rows = users.filter((u) => !u.removed).map((u) => (
    <tr key={u.id}>
      <td>{u.name || '—'}</td>
      <td>{u.email}</td>
      <td>{u.role === 'admin' ? <Badge text="Admin" tone="gray" /> : u.role === 'none' ? <Badge text="No access" tone="red" /> : 'Employee'}</td>
      <td>{fmt(u.lastSignInAt)}</td>
      <td>
        {u.id === meId ? <span className="muted small">You</span> : (
          <div className="user-actions">
            {u.role === 'none' && (
              <button className="btn" type="button" disabled={changingRole === u.id} onClick={() => onGiveAccess(u)}>
                {changingRole === u.id ? 'Saving…' : 'Give access'}
              </button>
            )}
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
      {status === 'ready' && removedUsers.length > 0 && (
        <section className="card">
          <CardHead icon="users" title={`Removed users (${removedUsers.length})`} />
          <p className="muted small card-note">Removed from the dashboard and blocked from signing in; kept in Supabase. Restore brings one back as an employee.</p>
          <DataTable
            status="ready" what="removed users" rows={removedRows} emptyIcon="users" emptyText="No removed users."
            head={['Name', 'Email', 'Last sign-in', ''].map((h, i) => <th key={i}>{h}</th>)}
          />
        </section>
      )}
      {confirmDialog}
    </main>
  );
}
