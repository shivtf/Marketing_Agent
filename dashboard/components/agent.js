'use client';
// The agent's status, shared by the Dashboard's Agent Control card and the sidebar's Agent Status box.
import { useState } from 'react';
import { useUpdateSection } from './DataProvider';
import { useConfirm } from './ConfirmDialog';
import * as api from '@/core/api';

// ---------- Agent Control ----------
// Pause / resume the Campaign Agent (docs/dashboard-pause-resume.md). It runs on the office machine and also starts and
// stops the Marketing Agent: pausing it stops the Marketing Agent too, resuming starts it again only if it was running
// when the pause came. Pause/resume are requests the agent applies within a few seconds (a request already running
// finishes first), so the status is polled until inSync (DataProvider).

// Badge, note and button for the status from app/api/ca.
export function describeAgent(a) {
  const wantsRun = a.desiredState === 'running';
  if (!a.online) {
    return { badge: 'Offline', wantsRun, note: `The assistant is offline. Requests wait until the office machine is back.${wantsRun ? '' : ' It stays paused.'}` };
  }
  if (!a.inSync) {
    return {
      badge: wantsRun ? 'Resuming…' : 'Pausing…', wantsRun, busy: true,
      note: wantsRun ? 'Resuming within a few seconds.' : 'Pausing after the current request finishes.',
    };
  }
  if (a.actualState === 'paused') {
    return { badge: 'Paused', wantsRun, note: 'No new requests are taken, and the Marketing Agent is stopped. Nothing is lost.' };
  }
  return { badge: 'Running', wantsRun, note: a.agentStatus === 'busy' ? 'Working on a request…' : 'Waiting for requests.' };
}

// Who may press what: everyone may pause (the safety brake), only admins resume (it can start the Marketing Agent
// again, which sends emails). app/api/ca/state enforces the same. -> 'pause' | 'resume' | null (nothing to press)
export const agentButton = (view, admin) => (view.wantsRun ? 'pause' : admin ? 'resume' : null);
export const ADMINS_RESUME = 'Only admins can resume the agent.';
export const BUTTON_LABEL = { pause: 'Pause Agent', resume: 'Resume Agent' };

// Pause / Resume. The answer replaces the cached status right away; DataProvider then polls until it is in sync.
// Pausing asks first, since it also stops the Marketing Agent mid-pass. Render `confirmDialog` once where the hook is used.
export function useAgentAction() {
  const update = useUpdateSection();
  const [confirmDialog, confirm] = useConfirm();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  async function act(action) {
    if (action === 'pause') {
      const ok = await confirm({
        title: 'Pause the agent?',
        message: 'The Campaign Agent takes no new requests, and the Marketing Agent stops (the pass in progress is cancelled). Nothing is lost; resuming starts them again.',
        confirmLabel: 'Pause Agent',
        danger: true,
      });
      if (!ok) return;
    }
    setError('');
    setActing(true);
    try {
      const fresh = await (action === 'pause' ? api.pauseAgent() : api.resumeAgent());
      update('agent', () => fresh);
    } catch (err) {
      setError(`Couldn't ${action} the agent: ${err.message}`);
    } finally {
      setActing(false);
    }
  }
  return { act, acting, error, confirmDialog };
}
