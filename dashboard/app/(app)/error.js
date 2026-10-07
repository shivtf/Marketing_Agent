'use client';
// Error boundary for the signed-in pages: a render crash shows this card (top bar stays) instead of a blank app.
import { useEffect } from 'react';
import { Icon } from '@/components/Icon';

export default function Error({ error, reset }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="page">
      <div className="card">
        <div className="error" role="alert">
          <Icon name="alert" />
          <div>Something went wrong on this page.</div>
          <button className="btn" onClick={reset}>Try again</button>
        </div>
      </div>
    </main>
  );
}
