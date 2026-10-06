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
// There is one marketing agent (approvals happen in Slack).

function AgentControl() {
  const { status, data, reload } = useSection('agent');
  const update = useUpdateSection();
  const [error, setError] = useState('');

  async function act(action) {
    const prev = data.status;
    setError('');
    // Optimistic update so the badge and buttons change instantly.
    update('agent', (a) => ({ ...a, status: action === 'start' ? 'running' : 'paused' }));
    try {
      await (action === 'start' ? api.startAgent() : api.pauseAgent());
    } catch {
      update('agent', (a) => ({ ...a, status: prev }));
      setError(`Couldn't ${action} the agent. Please try again.`);
    }
  }

  let card;
  if (status === 'loading') card = <div className="card"><Skeleton rows={3} /></div>;
  else if (status === 'error') card = <div className="card"><ErrorBox what="the agent status" onRetry={reload} /></div>;
  else {
    const running = data.status === 'running';
    card = (
      <div className="card pipe agent-card">
        <div className="card-head">
          <div className="tile"><Icon name="bolt" /></div>
          <div><div className="card-title">Marketing Agent</div><StatusBadge text={running ? 'Running' : 'Paused'} /></div>
        </div>
        <div className="row">
          <button className="btn primary" disabled={running} onClick={() => act('start')}><Icon name="play" /> Start</button>
          <button className="btn outline" disabled={!running} onClick={() => act('pause')}><Icon name="pause" /> Pause</button>
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
