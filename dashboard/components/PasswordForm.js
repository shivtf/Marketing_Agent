'use client';
// Current + new + confirm password form on the profile page.
import { useState } from 'react';
import * as auth from '@/core/auth';
import { endOtherSessions } from '@/core/api';

export default function PasswordForm() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const { current, next, confirm } = Object.fromEntries(new FormData(form));
    if (next.length < 8) return setMsg({ text: 'New password must be at least 8 characters.', tone: 'error' });
    if (next !== confirm) return setMsg({ text: 'New passwords do not match.', tone: 'error' });
    if (next === current) return setMsg({ text: 'New password must be different from the current one.', tone: 'error' });
    setBusy(true);
    setMsg({ text: '', tone: 'error' });
    try {
      await auth.changePassword(current, next);
      form.reset();
      // Supabase keeps other sessions alive after a password change: end them, so a stolen sign-in stops working.
      try {
        await endOtherSessions();
        setMsg({ text: 'Password updated. You were signed out on your other devices.', tone: 'ok' });
      } catch (err) {
        setMsg({ text: `Password updated, but your other devices are still signed in: ${err.message}`, tone: 'error' });
      }
    } catch (err) {
      setMsg({ text: err.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" noValidate onSubmit={onSubmit}>
      <label className="field"><span>Current password</span>
        <input name="current" type="password" autoComplete="current-password" required />
      </label>
      <label className="field"><span>New password</span>
        <input name="next" type="password" autoComplete="new-password" placeholder="At least 8 characters" required />
      </label>
      <label className="field"><span>Confirm new password</span>
        <input name="confirm" type="password" autoComplete="new-password" required />
      </label>
      <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>
      <button className={`btn primary auth-submit${busy ? ' loading' : ''}`} type="submit" disabled={busy}>Change password</button>
    </form>
  );
}
