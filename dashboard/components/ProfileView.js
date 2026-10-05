'use client';
// Profile page: who is signed in (left) and a password change form (right).
import { useEffect, useState } from 'react';
import { Badge, CardHead } from './ui';
import PasswordForm from './PasswordForm';
import * as auth from '@/core/auth';

const initials = (name, email) => (name || email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export default function ProfileView() {
  const [user, setUser] = useState(null);
  useEffect(() => { auth.getSession().then((s) => setUser(s?.user ?? null)); }, []);

  const name = user?.user_metadata?.name;
  const admin = user?.app_metadata?.role === 'admin';

  return (
    <main className="page">
      <div className="page-head"><h1 className="page-title">Profile</h1><p className="muted">Your account details and password.</p></div>
      <div className="profile-grid">
        <section className="card profile-id">
          <div className="avatar" aria-hidden="true">{user ? initials(name, user.email) : ''}</div>
          <div className="profile-name">{name || user?.email || ' '}</div>
          {name && <div className="muted profile-email">{user.email}</div>}
          {user && <Badge text={admin ? 'Admin' : 'Employee'} tone={admin ? 'amber' : 'gray'} />}
        </section>
        <section className="card profile-pw">
          <CardHead icon="check" title="Change password" />
          <p className="muted profile-hint">Use at least 8 characters. You&apos;ll need your current password to confirm.</p>
          <PasswordForm />
        </section>
      </div>
    </main>
  );
}
