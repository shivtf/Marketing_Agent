'use client';
// The marketing agent's status, shared by the Dashboard's Agent Control card and the sidebar's Agent Status box.
import { useState } from 'react';
import { useUpdateSection } from './DataProvider';
import { Badge } from './ui';
import { useConfirm } from './ConfirmDialog';
import * as api from '@/core/api';
import { fmtDate } from '@/core/format';

// ---------- Agent Control ----------
// There is one marketing agent, on the office machine (approvals happen in Slack). Start/Stop are requests: the agent
// applies them within about 5 s (stopping can take up to 30 s), so the status is polled until inSync (DataProvider).

export const STEPS = {
  inbox: 'Reading the inbox', replies: 'Classifying replies', send: 'Sending approved emails',
  followups: 'Drafting follow-ups', leads: 'Finding leads', blog: 'Writing the blog post',
};
export const OUTCOMES = { succeeded: 'Succeeded', failed: 'Failed', stopped: 'Stopped' };

// Badge, note and button for the pipeline status (pipeline-api.md, "Suggested UI").
export function describeAgent(a) {
  const wantsRun = a.desiredState === 'running';
  if (!a.online) {
    return { badge: 'Offline', wantsRun, note: `Office machine offline.${wantsRun ? ' It will start when it comes back.' : ''}` };
  }
  if (!a.inSync) {
    return {
      badge: wantsRun ? 'Starting…' : 'Stopping…', wantsRun, busy: true,
      note: wantsRun ? 'Starting within a few seconds.' : 'Stopping after the current step (up to 30 s).',
    };
  }
  if (a.state === 'running') {
    const step = a.currentPass && (STEPS[a.currentPass.step] || a.currentPass.step);
    const note = step ? `${step}…` : a.nextPassAt ? `Next pass at ${fmtDate(a.nextPassAt, 'table')}.` : 'Running.';
    return { badge: 'Running', wantsRun, note };
  }
  return { badge: 'Stopped', wantsRun, note: 'Nothing is searched, drafted or sent until you press Start.' };
}

// Whether real emails go out: the most important fact on the card, so it gets a badge next to the state.
export function EmailModeBadge({ agent }) {
  if (agent.sendingEnabled === false) return <Badge text="Sending off" tone="gray" title="Approved emails are not sent at all." />;
  if (agent.testMode) return <Badge text="Test mode" tone="blue" title="Every email goes to the test inbox, not to the real contact." />;
  if (agent.testMode === false) return <Badge text="Live emails" tone="red" title="Approved emails go to the real contacts." />;
  return null;
}

// Approved emails go to the real contacts (the "Live emails" badge above).
const sendsLiveEmails = (agent) => agent?.testMode === false && agent?.sendingEnabled !== false;

// Who may press what: only admins start the agent (it can send real emails), everyone may stop it (the safety brake;
// the backend enforces the same in dashboardbackend/app/agent.py). -> 'stop' | 'start' | null (nothing to press)
export const agentButton = (view, admin) => (view.wantsRun ? 'stop' : admin ? 'start' : null);
export const ADMINS_START = 'Only admins can start the agent.';

// Start / Stop. The answer replaces the cached status right away; DataProvider then polls until it is in sync.
// Starting with live emails asks first. Render `confirmDialog` once where the hook is used.
export function useAgentAction() {
  const update = useUpdateSection();
  const [confirmDialog, confirm] = useConfirm();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  async function act(action, agent) {
    if (action === 'start' && sendsLiveEmails(agent)) {
      const ok = await confirm({
        title: 'Start the agent with live emails?',
        message: 'Approved emails will go to the real contacts, not the test inbox.',
        confirmLabel: 'Start Agent',
        danger: true,
      });
      if (!ok) return;
    }
    setError('');
    setActing(true);
    try {
      const fresh = await (action === 'start' ? api.startAgent() : api.stopAgent());
      update('agent', () => fresh);
    } catch (err) {
      setError(`Couldn't ${action} the agent: ${err.message}`);
    } finally {
      setActing(false);
    }
  }
  return { act, acting, error, confirmDialog };
}
