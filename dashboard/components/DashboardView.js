'use client';
// Page 1: Agent Control + Leads Overview.
import { useState } from 'react';
import { Icon } from './Icon';
import { OpenRow } from './OpenRow';
import { useLeadsFilter, useSection, useUpdateSection, visibleLeads } from './DataProvider';
import { StatusBadge, SourceCell, Skeleton, ErrorBox, CardHead, ViewCell, DataTable, StatCards } from './ui';
import * as api from '@/core/api';
import { pad, fmtDate, SOURCES } from '@/core/format';

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

function AgentNote({ agent, note }) {
  const last = agent.lastPass;
  const lines = [
    note,
    last && `Last pass: ${OUTCOMES[last.outcome] || last.outcome} · ${fmtDate(last.finishedAt || last.startedAt, 'table')}`,
    agent.requestedBy && `Last ${agent.desiredState === 'running' ? 'started' : 'stopped'} by ${agent.requestedBy}.`,
    agent.sendingEnabled === false && 'Email sending is off.',
    agent.testMode && 'Test mode: emails go to the test inbox.',
  ].filter(Boolean);
  return <div className="muted small agent-note">{lines.map((l) => <div key={l}>{l}</div>)}</div>;
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
          <div><div className="card-title">Marketing Agent</div><StatusBadge text={v.badge} /></div>
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

function SourceBreakdown({ stats }) {
  const { status, data, reload } = stats;
  const keys = Object.keys(SOURCES);
  let body;
  if (status === 'loading') body = <Skeleton rows={3} />;
  else if (status === 'error') body = <ErrorBox what="lead sources" onRetry={reload} />;
  else {
    const { bySource } = data;
    body = (
      <>
        <div className="stack" role="img" aria-label={keys.map((k) => `${SOURCES[k].label} ${bySource[k]}`).join(', ')}>
          {keys.map((k) => (
            <span
              key={k}
              style={{ flexGrow: bySource[k], background: SOURCES[k].color }}
              title={`${SOURCES[k].label}: ${bySource[k]}`}
            />
          ))}
        </div>
        <div className="legend">
          {keys.map((k) => (
            <div key={k} className="legend-item">
              <Icon name={SOURCES[k].icon} />
              <span className="legend-label">{SOURCES[k].label}</span><span className="legend-count">{bySource[k]}</span>
            </div>
          ))}
        </div>
      </>
    );
  }
  return <div className="card"><CardHead icon="users" title="Leads by Source" />{body}</div>;
}

// ---------- Leads table ----------
function Chip({ group, value, children }) {
  const { filter, setFilter } = useLeadsFilter();
  const on = filter[group] === value;
  const select = () => setFilter((f) => ({ ...f, [group]: value }));
  return (
    <button className={`chip${on ? ' active' : ''}`} aria-pressed={on} onClick={select}>
      {children}
    </button>
  );
}

function LeadsTable() {
  const { status, data, reload } = useSection('leads');
  const { filter } = useLeadsFilter();
  const list = visibleLeads(data, filter);
  return (
    <div className="card">
      {status === 'ready' && data.length > 0 && (
        <div className="filters">
          <div className="chip-group">
            <Chip group="status" value="all">All</Chip>
            <Chip group="status" value="awaiting">Awaiting</Chip>
            <Chip group="status" value="responded">Responded</Chip>
          </div>
          <div className="chip-group">
            <Chip group="source" value="all">All sources</Chip>
            {Object.entries(SOURCES).map(([k, v]) => <Chip key={k} group="source" value={k}>{v.label}</Chip>)}
          </div>
        </div>
      )}
      <DataTable
        status={status}
        head={(
          <>
            <th>#</th><th>Name</th><th>Source</th><th>Status</th><th>Date Added</th><th className="view">View</th>
          </>
        )}
        rows={list.map((l) => (
          <OpenRow key={l.id} kind="lead" id={l.id}>
            <td className="num">{pad(l.number)}</td>
            <td className="name">{l.name}</td>
            <td><SourceCell source={l.source} /></td>
            <td><StatusBadge text={l.status} /></td>
            <td className="muted">{fmtDate(l.addedAt, 'date')}</td>
            <ViewCell />
          </OpenRow>
        ))}
        emptyIcon="users"
        emptyText={data.length ? 'No leads match these filters' : 'No leads yet'}
        what="leads"
        onRetry={reload}
      />
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
