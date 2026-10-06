'use client';
// Login page: email + password sign-in. Accounts are created by an admin, so there is no self-service reset.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './Icon';
import * as auth from '@/core/auth';

export default function LoginView() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  // Signed-in users skip this page; the stylesheet hides the top bar and centres the card via body.auth-view.
  useEffect(() => {
  let cancelled = false;
  auth.getSession().then((session) => {
    if (cancelled) return;
    if (session) router.replace(auth.mustChangePassword(session) ? '/change-password' : '/dashboard');
    else { document.body.classList.add('auth-view'); emailRef.current?.focus(); }
  });
  return () => { cancelled = true; document.body.classList.remove('auth-view'); };
}, [router]);

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg({ text: '', tone: 'error' });
    const email = emailRef.current.value.trim();
    try {
      const session = await auth.signIn(email, passwordRef.current.value);
      router.replace(auth.mustChangePassword(session) ? '/change-password' : '/dashboard');
      return;
    } catch (err) {
      setMsg({ text: err.message || 'Something went wrong. Please try again.', tone: 'error' });
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="auth-card card">
        <div className="tile"><Icon name="bolt" /></div>
        <h1 className="auth-title">Welcome back</h1>
        <p className="auth-sub muted">Sign in to your Marketing AI Agent dashboard.</p>
        <form className="auth-form" noValidate onSubmit={onSubmit}>
          <label className="field"><span>Email</span>
            <input ref={emailRef} id="auth-email" name="email" type="email" autoComplete="username" placeholder="you@company.com" required />
          </label>
          <label className="field"><span>Password</span>
            <span className="pw-wrap">
              <input
                ref={passwordRef}
                id="auth-password"
                name="password"
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="At least 8 characters"
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
          <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>
          <button className={`btn primary auth-submit${busy ? ' loading' : ''}`} type="submit" disabled={busy}>Sign in</button>
        </form>
        <p className="auth-sub muted auth-help">Forgot your password? Contact your admin.</p>
      </div>
    </main>
  );
}
