'use client';
// Forced first-login page: employees on the default password must set their own before using the app.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './Icon';
import PasswordForm from './PasswordForm';
import * as auth from '@/core/auth';

export default function ChangePasswordView() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    auth.getSession().then((session) => {
      if (cancelled) return;
      if (!session) router.replace('/login');
      else if (!auth.mustChangePassword(session)) router.replace('/dashboard');
      else document.body.classList.add('auth-view');
    });
    return () => { cancelled = true; document.body.classList.remove('auth-view'); };
  }, [router]);

  const signOut = async () => { await auth.signOut(); router.replace('/login'); };

  return (
    <main className="page">
      <div className="auth-card card">
        <div className="tile"><Icon name="bolt" /></div>
        <h1 className="auth-title">Set your password</h1>
        <p className="auth-sub muted">You&apos;re using a default password. Choose your own to continue.</p>
        <PasswordForm submitLabel="Save and continue" onDone={() => router.replace('/dashboard')} />
        <button className="link-btn" type="button" onClick={signOut}>Sign out</button>
      </div>
    </main>
  );
}
