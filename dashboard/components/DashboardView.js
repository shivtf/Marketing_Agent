'use client';
// Page 1: Agent Control + Leads Overview.
import { useState } from 'react';
import { Icon } from './Icon';
import { OpenRow } from './OpenRow';
import { useList, useSection, useUpdateSection } from './DataProvider';
import { Badge, StatusBadge, SourceCell, Skeleton, ErrorBox, CardHead, ViewCell, DataTable, StatCards, Pager } from './ui';
import * as api from '@/core/api';
import { pad, fmtDate, sourceLabel } from '@/core/format';

// ---------- Agent Control ----------
// There is one marketing agent, on the office machine (approvals happen in Slack). Start/Stop are requests: the agent
// applies them within about 5 s (stopping can take up to 30 s), so the status is polled until inSync (DataProvider).

const STEPS = {
  inbox: 'Reading the inbox', replies: 'Classifying replies', send: 'Sending approved emails',
  followups: 'Drafting follow-ups', leads: 'Finding leads', blog: 'Writing the blog post',
};
const OUTCOMES = { succeeded: 'Succeeded', failed: 'Failed', stopped: 'Stopped' };

// Badge, note and button for the pipeline status (pipeline-api.md, "Suggested UI").
function describeAgent(a) {
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
function EmailModeBadge({ agent }) {
  if (agent.sendingEnabled === false) return <Badge text="Sending off" tone="gray" title="Approved emails are not sent at all." />;
  if (agent.testMode) return <Badge text="Test mode" tone="blue" title="Every email goes to the test inbox, not to the real contact." />;
  if (agent.testMode === false) return <Badge text="Live emails" tone="red" title="Approved emails go to the real contacts." />;
  return null;
}

// When the agent started/stopped (stateSince), who pressed the button and when (requestedAt), and the last run.
// A run's own times are not the stop time: stopping mid-run ends a run that may have started long before.
function AgentNote({ agent, note }) {
  const last = agent.lastPass;
  const running = agent.desiredState === 'running';
  const since = agent.inSync && agent.stateSince
    && (agent.state === 'running' ? `Running since ${fmtDate(agent.stateSince, 'table')}`
      : agent.state === 'stopped' ? `Stopped at ${fmtDate(agent.stateSince, 'table')}` : null);
  // Who pressed the button: their name (agent.py looks it up), else what the API recorded ("dashboard:<email>",
  // or a name when started/stopped from the agent's CLI).
  const who = agent.requestedByName || agent.requestedBy?.replace(/^dashboard:/, '');
  const by = who && [
    `${running ? 'Started' : 'Stopped'} by ${who}`,
    agent.requestedAt && fmtDate(agent.requestedAt, 'table'),
  ].filter(Boolean).join(' · ');
  const run = last && `Last run: ${OUTCOMES[last.outcome] || last.outcome} · ${
    last.finishedAt ? `ended ${fmtDate(last.finishedAt, 'table')}` : `started ${fmtDate(last.startedAt, 'table')}`}`;
  const details = [since, by, run].filter(Boolean);
  return (
    <div className="small agent-note">
      <div>{note}</div>
      {details.map((l) => <div key={l} className="muted">{l}</div>)}
    </div>
  );
}

function AgentControl() {
  const { status, data, reload } = useSection('agent');
  const update = useUpdateSection();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');

  async function act(action) {
    setError('');
    setActing(true);
    try {
      const fresh = await (action === 'start' ? api.startAgent() : api.stopAgent());
      update('agent', () => fresh); // not in sync yet: DataProvider polls until it is
    } catch (err) {
      setError(`Couldn't ${action} the agent: ${err.message}`);
    } finally {
      setActing(false);
    }
  }

  let card;
  if (status === 'loading') card = <div className="card"><Skeleton rows={3} /></div>;
  else if (status === 'error') card = <div className="card"><ErrorBox what="the agent status" onRetry={reload} /></div>;
  else {
    const v = describeAgent(data);
    const disabled = acting || v.busy;
    card = (
      <div className="card pipe agent-card">
        <div className="card-head">
          <div className="tile"><Icon name="bolt" /></div>
          <div>
            <div className="card-title">Marketing Agent</div>
            <div className="badges"><StatusBadge text={v.badge} /><EmailModeBadge agent={data} /></div>
          </div>
        </div>
        <AgentNote agent={data} note={v.note} />
        <div className="row">
          {v.wantsRun
            ? <button className="btn outline" disabled={disabled} onClick={() => act('stop')}><Icon name="pause" /> Stop</button>
            : <button className="btn primary" disabled={disabled} onClick={() => act('start')}><Icon name="play" /> Start</button>}
        </div>
      </div>
    );
  }

  return (
    <section aria-label="Agent control">
      <div className="section-head"><h2 className="section-title">Agent Control</h2></div>
      {error && <div className="notice">{error}</div>}
      {card}
    </section>
  );
}

// ---------- Leads Overview: stat cards + source breakdown ----------
const STATS = [
  { key: 'total', label: 'Total Leads', icon: 'users' },
  { key: 'awaiting', label: 'Awaiting Response', icon: 'clock', tone: 'lavender' },
  { key: 'responded', label: 'Responded', icon: 'reply', tone: 'green' },
];

function LeadStatCards({ stats }) {
  const { status, data, reload } = stats;
  return <StatCards items={STATS.map((s) => ({ ...s, value: data?.[s.key], status, onRetry: reload }))} />;
}

// One bar per source the agent actually found leads on, most leads first; bar length = share of all leads.
// A single colour: the label next to each bar says which source it is, so any number of sources fits.
function SourceBreakdown({ stats }) {
  const { status, data, reload } = stats;
  let body;
  if (status === 'loading') body = <Skeleton rows={3} />;
  else if (status === 'error') body = <ErrorBox what="lead sources" onRetry={reload} />;
  else {
    const entries = Object.entries(data.bySource); // backend sends most leads first
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    body = !total ? <div className="muted small">No leads yet.</div> : (
      <ul className="source-bars">
        {entries.map(([k, n]) => {
          const pct = Math.round((n / total) * 100);
          return (
            <li key={k} className="source-bar" title={`${sourceLabel(k)}: ${n} lead${n === 1 ? '' : 's'} (${pct}%)`}>
              <span className="source-name">{sourceLabel(k)}</span>
              <span className="source-track" aria-hidden="true"><span className="source-fill" style={{ width: `${(n / total) * 100}%` }} /></span>
              <span className="source-count">{n}<span className="muted"> · {pct}%</span></span>
            </li>
          );
        })}
      </ul>
    );
  }
  return <div className="card"><CardHead icon="users" title="Leads by Source" />{body}</div>;
}

// ---------- Leads table ----------
// Every lead, newest first, one page at a time: the company, the email we found and when the lead came in.
// What the company does is in the lead drawer.
function LeadsTable() {
  const leads = useList('leads');
  const { status, data, reload, fetching } = leads;
  return (
    <div className="card">
      <DataTable
        status={status}
        head={(
          <>
            <th>#</th><th>Company</th><th>Email</th><th>Source</th><th>Status</th><th>Added</th><th className="view">View</th>
          </>
        )}
        busy={fetching}
        scrollKey={data.page}
        rows={data.items.map((l) => (
          <OpenRow key={l.id} kind="lead" id={l.id}>
            <td className="num">{pad(l.number)}</td>
            <td className="name">{l.company || 'Unknown company'}</td>
            <td className="muted">{l.email || '—'}</td>
            <td><SourceCell source={l.source} /></td>
            <td><StatusBadge text={l.status} /></td>
            <td className="muted nowrap">{fmtDate(l.addedAt, 'table')}</td>
            <ViewCell />
          </OpenRow>
        ))}
        emptyIcon="users"
        emptyText="No leads yet"
        what="leads"
        onRetry={reload}
      />
      <Pager list={leads} />
    </div>
  );
}

export default function DashboardView() {
  const stats = useSection('stats');
  return (
    <main className="page">
      <AgentControl />
      <section aria-label="Leads overview">
        <div className="section-head"><h2 className="section-title">Leads Overview</h2></div>
        <div className="stack-v">
          <LeadStatCards stats={stats} />
          <div><SourceBreakdown stats={stats} /></div>
          <div><LeadsTable /></div>
        </div>
      </section>
    </main>
  );
}
