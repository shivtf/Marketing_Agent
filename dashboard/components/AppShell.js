'use client';
// Shell for the signed-in pages: auth guard, top bar, shared data store and the single drawer.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon } from './Icon';
import { ErrorBox, Skeleton } from './ui';
import { DataProvider } from './DataProvider';
import { DrawerProvider } from './DrawerProvider';
import * as auth from '@/core/auth';
import { getMe, releaseAccount } from '@/core/api';

const TABS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/history', label: 'History' },
  { href: '/positive-leads', label: 'Positive Leads' },
  { href: '/blogs', label: 'Blogs' },
];
const ADMIN_TABS = [{ href: '/users', label: 'Users' }];
const PROFILE_TAB = { href: '/profile', label: 'Profile' };

function Topbar({ admin }) {
  const pathname = usePathname();
  const router = useRouter();

  // On narrow screens the tab row scrolls sideways; keep the active tab visible.
  useEffect(() => { document.querySelector('.tab.active')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [pathname]);

  // Theme switch: persisted in localStorage, applied via data-theme on <html> (set early in app/layout.js).
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
  };

  const signOut = async () => {
    await releaseAccount().catch(() => {}); // signing out works even when the backend can't be reached
    await auth.signOut();
    router.replace('/login');
  };

  return (
    <header className="topbar">
      <div className="topbar-in">
        <nav className="tabs" aria-label="Main">
          {[...TABS, ...(admin ? ADMIN_TABS : []), PROFILE_TAB].map((t) => {
            const on = pathname === t.href;
            return <Link key={t.href} className={`tab${on ? ' active' : ''}`} href={t.href} aria-current={on ? 'page' : undefined}>{t.label}</Link>;
          })}
        </nav>
        <button className="theme-toggle" type="button" aria-label="Toggle dark mode" onClick={toggleTheme}>
          <span className="moon"><Icon name="moon" /></span><span className="sun"><Icon name="sun" /></span>
        </button>
        <button className="btn signout" type="button" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );
}

export function AppShell({ children }) {
  const router = useRouter();
  const [state, setState] = useState('checking'); // 'checking' | 'ready' | 'offline'
  const [attempt, setAttempt] = useState(0);
  const [admin, setAdmin] = useState(false);

  // Guard: signed-out users only see the login page. The session is read locally, so the app renders right away;
  // /auth/me runs alongside the first data fetches and signs the user out if the backend rejects the token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await auth.getSession();
      if (cancelled) return;
      if (!session) { router.replace('/login'); return; }
      setAdmin(auth.isAdmin(session));
      setState('ready');
      try {
        await getMe();
      } catch (err) {
        if (cancelled) return;
        if (err.status === 0) { setState('offline'); return; }
        // Backend rejected the session: end it in this browser only (a global sign-out would also end the
        // session of whoever is using the account on another device).
        await auth.endSession(err.message);
      }
    })().catch(() => { if (!cancelled) router.replace('/login'); });
    return () => { cancelled = true; };
  }, [router, attempt]);

  // Check in every minute while the app is open, so this session keeps the account (one sign-in per account).
  // getMe returns to the login page if the session has ended or the account was taken over.
  useEffect(() => {
    if (state !== 'ready') return undefined;
    const t = setInterval(() => { getMe().catch(() => {}); }, 60_000);
    return () => clearInterval(t);
  }, [state]);

  if (state === 'offline') {
    return (
      <main className="page">
        <ErrorBox what="the server" onRetry={() => { setState('checking'); setAttempt((n) => n + 1); }} />
      </main>
    );
  }
  if (state !== 'ready') {
    return <main className="page" aria-busy="true" aria-label="Loading"><Skeleton rows={6} /></main>;
  }
  return (
    <DataProvider>
      <DrawerProvider>
        <Topbar admin={admin} />
        {children}
      </DrawerProvider>
    </DataProvider>
  );
}
