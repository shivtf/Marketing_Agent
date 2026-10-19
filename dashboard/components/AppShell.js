'use client';
// Shell for the signed-in pages: auth guard, sidebar + header, shared data store and the single drawer.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon } from './Icon';
import { ErrorBox, Skeleton } from './ui';
import { DataProvider, useSection } from './DataProvider';
import { ADMINS_RESUME, agentButton, BUTTON_LABEL, describeAgent, useAgentAction } from './agent';
import { DrawerProvider } from './DrawerProvider';
import * as auth from '@/core/auth';
import { getMe, releaseAccount } from '@/core/api';
import { fmtDate, toneOf } from '@/core/format';

const TABS = [
  { href: '/dashboard', label: 'Dashboard', icon: 'home' },
  { href: '/history', label: 'History', icon: 'clock' },
  { href: '/positive-leads', label: 'Positive Leads', icon: 'check' },
  { href: '/needs-contact', label: 'Needs Contact', icon: 'mail' },
  { href: '/blogs', label: 'Blogs', icon: 'doc' },
  { href: '/campaign', label: 'Campaign', icon: 'megaphone' },
];
const ADMIN_TABS = [{ href: '/users', label: 'Users', icon: 'users' }];

const initials = (name, email) => (name || email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// Sidebar box with the agent's state and Pause/Resume, so it can be used from any page (Resume: admins only).
function AgentStatusBox({ admin }) {
  const { status, data } = useSection('agent');
  const { act, acting, error, confirmDialog } = useAgentAction();
  if (status !== 'ready' || !data) return null;
  const v = describeAgent(data);
  const button = agentButton(v, admin);
  return (
    <div className="side-agent">
      <div className="side-agent-title" title={`Agent: ${v.badge}`}>
        <span className={`agent-dot ${toneOf(v.badge)}`} aria-hidden="true" /><span className="side-label">Agent Status</span>
      </div>
      <div className="side-agent-state">
        <span className={`agent-word small ${toneOf(v.badge)}`}>{v.badge}</span>
      </div>
      {data.stateSince && data.inSync && (
        <>
          <div className="muted small">{data.actualState === 'paused' ? 'Paused at' : 'Running since'}</div>
          <div className="side-agent-when">{fmtDate(data.stateSince, 'table')}</div>
        </>
      )}
      {error && <div className="notice small">{error}</div>}
      {button ? (
        <button
          className="btn primary side-agent-btn"
          disabled={acting || v.busy}
          onClick={() => act(button)}
          title={BUTTON_LABEL[button]}
        >
          <Icon name={button === 'pause' ? 'pause' : 'play'} /> <span className="side-label">{BUTTON_LABEL[button]}</span>
        </button>
      ) : <div className="muted small side-label">{ADMINS_RESUME}</div>}
      {confirmDialog}
    </div>
  );
}

// Left sidebar: brand, one link per page, and the agent's status. On desktop it is a slim icon rail that slides open
// over the page while hovered (or while a keyboard user tabs through it). On narrow screens it becomes a row across the top that scrolls sideways (the status box is hidden there).
export function Sidebar({ admin }) {
  const pathname = usePathname();

  // Keep the active link visible when the row scrolls sideways.
  useEffect(() => { document.querySelector('.side-link.active')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [pathname]);

  return (
    <aside className="sidebar">
      <Link className="side-brand" href="/dashboard">
        <span className="tile sm"><Icon name="bolt" /></span>
        <span className="side-brand-text"><b>Marketing AI Agent</b><span className="muted small">Dashboard</span></span>
      </Link>
      <nav className="side-nav" aria-label="Main">
        {[...TABS, ...(admin ? ADMIN_TABS : [])].map((t) => {
          const on = pathname === t.href;
          return (
            <Link key={t.href} className={`side-link${on ? ' active' : ''}`} href={t.href} aria-current={on ? 'page' : undefined} title={t.label}>
              <Icon name={t.icon} /><span className="side-label">{t.label}</span>
            </Link>
          );
        })}
      </nav>
      <AgentStatusBox admin={admin} />
    </aside>
  );
}

// Top header: the theme switch and the signed-in user (menu: Profile, Sign out).
export function Header({ user }) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  // Close the menu on a click outside it or on Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // Theme switch: persisted in localStorage, applied via data-theme on <html> (set early in app/layout.js).
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
  };

  // Ending the Supabase session is what frees the account: the backend lets another device take it once the session
  // no longer exists (dashboardbackend/app/auth.py). So the backend is told in the background, not waited for: it
  // can be slow (several database round trips, a sleeping server), and sign-out must not wait on it. Started first so
  // it still carries this session's token; if it arrives after the session ended, it is refused, which is harmless.
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    releaseAccount().catch(() => {});
    await auth.signOut().catch(() => {}); // clears the session in this browser even when Supabase can't be reached
    router.replace('/login');
  };

  const name = user?.user_metadata?.name;
  return (
    <header className="topbar">
      <div className="topbar-in">
        <button className="theme-toggle" type="button" aria-label="Toggle dark mode" onClick={toggleTheme}>
          <span className="moon"><Icon name="moon" /></span><span className="sun"><Icon name="sun" /></span>
        </button>
        <div className="user-menu" ref={menuRef}>
          <button className="user-chip" type="button" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <span className="user-avatar" aria-hidden="true">{user ? initials(name, user.email) : ''}</span>
            <span className="user-name">{name || user?.email}</span>
            <Icon name="chevD" />
          </button>
          {menu && (
            <div className="menu" role="menu">
              <Link className="menu-item" role="menuitem" href="/profile" onClick={() => setMenu(false)}><Icon name="user" /> Profile</Link>
              <button className="menu-item" role="menuitem" type="button" disabled={signingOut} aria-busy={signingOut} onClick={signOut}>
                <Icon name="logout" /> {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function AppShell({ children }) {
  const router = useRouter();
  const [state, setState] = useState('checking'); // 'checking' | 'ready' | 'offline'
  const [attempt, setAttempt] = useState(0);
  const [admin, setAdmin] = useState(false);
  const [user, setUser] = useState(null);

  // Guard: signed-out users only see the login page. The session is read locally, so the app renders right away;
  // /auth/me runs alongside the first data fetches and signs the user out if the backend rejects the token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await auth.getSession();
      if (cancelled) return;
      if (!session) { router.replace('/login'); return; }
      setAdmin(auth.isAdmin(session));
      setUser(session.user);
      setState('ready');
      try {
        await getMe();
      } catch (err) {
        if (cancelled) return;
        // Backend unreachable, or it couldn't check the sign-in (503: it refuses rather than guess): stay signed in
        // and offer Retry.
        if (err.status === 0 || err.status >= 500) { setState('offline'); return; }
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
        <div className="app">
          <Sidebar admin={admin} />
          <div className="app-main">
            <Header user={user} />
            {children}
          </div>
        </div>
      </DrawerProvider>
    </DataProvider>
  );
}
