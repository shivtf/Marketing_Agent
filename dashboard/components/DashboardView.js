'use client';
// Page 1: a greeting; the Lead Pipeline and Recent Leads on the left;
// Agent Control and Leads by Source on the right. Everything shown comes from /api/ca, /leads/stats and /leads.
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { OpenRow } from './OpenRow';
import { useList, useSection } from './DataProvider';
import { StatusBadge, Skeleton, ErrorBox, DataTable, Pager } from './ui';
import { ADMINS_RESUME, agentButton, BUTTON_LABEL, describeAgent, useAgentAction } from './agent';
import { getSession, isAdmin } from '@/core/auth';
import { fmtDate, sourceLabel, toneOf } from '@/core/format';

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
// "Oct 12, 9:36 AM": short enough for one line in the narrow Agent Control card.
const shortTime = (iso) => (iso ? `${fmtDate(iso, 'date').replace(/, \d{4}$/, '')}, ${fmtDate(iso, 'table').split(' ').slice(-2).join(' ')}` : '—');

// ---------- Greeting ----------
function Greeting() {
  const [name, setName] = useState('');
  useEffect(() => {
    getSession().then((s) => setName(s?.user?.user_metadata?.name?.split(' ')[0] || s?.user?.email?.split('@')[0] || ''));
  }, []);
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return (
    <div className="hero">
      <div className="hero-text">
        <h1 className="hero-title">Good {part}{name && `, ${name}`} <span className="hero-wave" aria-hidden="true">👋</span></h1>
        <p className="hero-sub">Your marketing agent is finding potential customers and creating outreach opportunities.</p>
      </div>
      <div className="hero-art" aria-hidden="true">
        <svg viewBox="0 0 460 120" preserveAspectRatio="xMaxYMax meet">
          <defs>
            <linearGradient id="hero-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="hero-far-a" /><stop offset="1" className="hero-far-b" /></linearGradient>
            <linearGradient id="hero-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="hero-near-a" /><stop offset="1" className="hero-near-b" /></linearGradient>
          </defs>
          <circle cx="250" cy="36" r="15" className="hero-sun" />
          {/* Dark mode: a crescent moon and a few stars in place of the sun. */}
          <g className="hero-night">
            <path d="M256 22 a15 15 0 1 0 8 26 a12 12 0 1 1 -8 -26 z" className="hero-moon" />
            <circle cx="200" cy="24" r="1.4" /><circle cx="300" cy="16" r="1.2" /><circle cx="330" cy="44" r="1" />
            <circle cx="170" cy="46" r="1" /><circle cx="226" cy="10" r="1" />
          </g>
          <path d="M20 120 C70 104 110 64 150 54 C176 48 190 72 212 62 C242 48 262 18 300 30 C330 40 344 78 376 84 C404 89 430 100 460 108 V120 Z" fill="url(#hero-far)" />
          <path d="M0 120 C50 110 82 92 124 96 C166 100 186 82 228 88 C270 94 292 108 334 102 C376 96 410 104 460 114 V120 Z" fill="url(#hero-near)" />
          <g className="hero-tree"><path d="M178 92 l8 -24 l8 24 z" /><path d="M181 82 l5 -16 l5 16 z" /><rect x="185" y="91" width="2" height="7" /></g>
          <g className="hero-tree"><path d="M198 95 l6 -16 l6 16 z" /><rect x="203" y="94" width="2" height="6" /></g>
          <g className="hero-tree"><path d="M372 98 l6 -18 l6 18 z" /><rect x="377" y="97" width="2" height="6" /></g>
        </svg>
        <p className="hero-quote">“Find opportunities<br />Build relationships<br />Create impact.”</p>
      </div>
    </div>
  );
}

// ---------- Lead Pipeline: where every lead stands ----------
// Every lead is in exactly one of No Contact, Not Sent, Awaiting, Responded and Bounced, so Awaiting + Responded + Bounced add up
// to Emailed. Emailed is a share of all leads; the three after it are shares of emailed leads, like the stat cards.
function Pipeline({ stats }) {
  const { status, data, reload } = stats;
  let body;
  if (status === 'loading') body = <Skeleton rows={3} />;
  else if (status === 'error') body = <ErrorBox what="the lead pipeline" onRetry={reload} />;
  else {
    const noContact = data.noContact ?? 0;
    const emailed = data.total - data.notSent - noContact;
    const stages = [
      { label: 'Found', icon: 'building', tone: 'blue', n: data.total,
        note: noContact ? `${data.notSent} to email · ${noContact} no contact` : `${data.notSent} not emailed yet` },
      { label: 'Emailed', icon: 'send', tone: 'green', n: emailed, of: data.total, ofWhat: 'all leads' },
      { label: 'Awaiting', icon: 'mail', tone: 'amber', n: data.awaiting, of: emailed, ofWhat: 'emailed leads' },
      { label: 'Responded', icon: 'reply', tone: 'lavender', n: data.responded, of: emailed, ofWhat: 'emailed leads' },
      { label: 'Bounced', icon: 'alert', tone: 'red', n: data.bounced ?? 0, of: emailed, ofWhat: 'emailed leads' },
    ];
    body = (
      <ol className="stages">
        {stages.map((s, i) => (
          <li key={s.label} className="stage-wrap">
            {i > 0 && <span className="stage-arrow" aria-hidden="true"><Icon name="arrow" /></span>}
            <div className={`stage ${s.tone}`}>
              <div className="stage-top">
                <span className="stage-icon"><Icon name={s.icon} /></span>
                <div>
                  <div className="stage-label">{s.label}</div>
                  <div className="stage-n">{s.n}</div>
                </div>
              </div>
              {s.note ? <div className="stage-note muted small">{s.note}</div> : (
                <div className="stage-foot" title={`${pct(s.n, s.of)}% of ${s.ofWhat}`}>
                  <span className="stage-track" aria-hidden="true"><span style={{ width: `${pct(s.n, s.of)}%` }} /></span>
                  <span className="stage-pct">{pct(s.n, s.of)}%</span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <section className="card">
      <h2 className="panel-title"><Icon name="funnel" /> Lead Pipeline</h2>
      <p className="muted small panel-note">Emailed is a share of all leads; Awaiting, Responded and Bounced are shares of emailed leads.</p>
      {body}
    </section>
  );
}

// ---------- Recent Leads: every lead, newest first, one page at a time ----------
const LOGO_TONES = ['blue', 'green', 'red', 'amber', 'lavender', 'slate'];
const logoTone = (name = '') => LOGO_TONES[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % LOGO_TONES.length];

function RecentLeads() {
  const leads = useList('leads');
  const { status, data, reload, fetching } = leads;
  return (
    <section className="card leads-card">
      <h2 className="panel-title"><Icon name="stack" /> Recent Leads</h2>
      <DataTable
        status={status}
        head={<><th>Company</th><th className="email">Email</th><th>Source</th><th>Status</th><th>Date Added</th><th className="actions">Actions</th></>}
        busy={fetching}
        scrollKey={data.page}
        rows={data.items.map((l) => {
          const company = l.company || 'Unknown company';
          return (
            <OpenRow key={l.id} kind="lead" id={l.id}>
              <td>
                <div className="co">
                  <span className={`co-logo ${logoTone(company)}`} aria-hidden="true">{company[0].toUpperCase()}</span>
                  <span className="co-text">
                    <span className="name">{company}</span>
                    <span className="co-email muted small">{l.email || '—'}</span>
                  </span>
                </div>
              </td>
              <td className="muted email" title={l.email || undefined}>{l.email || '—'}</td>
              <td><span className="pill">{sourceLabel(l.source)}</span></td>
              <td><StatusBadge text={l.status} /></td>
              <td className="muted nowrap" title={fmtDate(l.addedAt)}>{fmtDate(l.addedAt, 'date')}</td>
              <td className="actions">
                {l.email && (
                  <a className="row-icon" href={`mailto:${l.email}`} aria-label={`Email ${company}`} onClick={(e) => e.stopPropagation()}>
                    <Icon name="mail" />
                  </a>
                )}
                <span className="row-icon" aria-label="View"><Icon name="eye" /></span>
              </td>
            </OpenRow>
          );
        })}
        emptyIcon="users"
        emptyText="No leads yet"
        what="leads"
        onRetry={reload}
      />
      <Pager list={leads} />
    </section>
  );
}

// ---------- Agent Control (Pause: everyone; Resume: admins only) ----------
function AgentControl() {
  const { status, data, reload } = useSection('agent');
  const { act, acting, error, confirmDialog } = useAgentAction();
  const [admin, setAdmin] = useState(false);
  useEffect(() => { getSession().then((s) => setAdmin(isAdmin(s))); }, []);

  let body;
  if (status === 'loading') body = <Skeleton rows={4} />;
  else if (status === 'error') body = <ErrorBox what="the agent status" onRetry={reload} />;
  else {
    const v = describeAgent(data);
    const button = agentButton(v, admin);
    const paused = data.actualState === 'paused';
    const rows = [
      ['Current task', v.note],
      data.inSync && data.stateSince && [paused ? 'Paused at' : 'Running since', shortTime(data.stateSince)],
      data.requestedBy && [data.desiredState === 'paused' ? 'Paused by' : 'Resumed by', data.requestedByName || data.requestedBy, true], // one line, cut with …
      !data.online && data.lastSeen && ['Last seen', shortTime(data.lastSeen)],
    ].filter(Boolean);
    body = (
      <>
        <div className="agent-state">
          <span className={`agent-dot ${toneOf(v.badge)}`} aria-hidden="true" />
          <span className={`agent-word ${toneOf(v.badge)}`}>{v.badge}</span>
        </div>
        {button ? (
          <button
            className="btn primary agent-btn"
            disabled={acting || v.busy}
            onClick={() => act(button)}
          >
            <Icon name={button === 'pause' ? 'pause' : 'play'} /> {BUTTON_LABEL[button]}
          </button>
        ) : <p className="muted small">{ADMINS_RESUME}</p>}
        <dl className="kv">
          {rows.map(([k, val, cut]) => <div key={k} className="kv-row"><dt>{k}</dt><dd className={cut ? 'kv-cut' : undefined} title={cut ? val : undefined}>{val}</dd></div>)}
        </dl>
      </>
    );
  }
  return (
    <section className="card agent-panel" aria-label="Agent control">
      <h2 className="panel-title"><Icon name="bolt" /> Agent Control</h2>
      {error && <div className="notice">{error}</div>}
      {body}
      {confirmDialog}
    </section>
  );
}

// ---------- Leads by Source: one row per source, most leads first ----------
const SOURCE_TONES = ['blue', 'green', 'lavender', 'amber', 'red', 'slate'];
const sourceIcon = (k) => (k === 'search' ? 'search' : k === 'company_search' ? 'building' : k === 'feed' ? 'doc' : k === 'other' ? 'bolt' : 'briefcase');

function SourceList({ stats }) {
  const { status, data, reload } = stats;
  let body;
  if (status === 'loading') body = <Skeleton rows={4} />;
  else if (status === 'error') body = <ErrorBox what="lead sources" onRetry={reload} />;
  else {
    const entries = Object.entries(data.bySource); // backend sends most leads first
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    body = !total ? <div className="muted small">No leads yet.</div> : (
      <ul className="feed">
        {entries.map(([k, n], i) => {
          const tone = SOURCE_TONES[i % SOURCE_TONES.length];
          return (
            <li key={k} className={`feed-item ${tone}`}>
              <span className="feed-dot" aria-hidden="true" />
              <span className="feed-icon"><Icon name={sourceIcon(k)} /></span>
              <span className="feed-text">
                <span className="feed-title">{sourceLabel(k)}</span>
                <span className="feed-sub">{pct(n, total)}% of leads</span>
              </span>
              <span className="feed-count">{n}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section className="card">
      <h2 className="panel-title"><Icon name="chart" /> Leads by Source</h2>
      {body}
    </section>
  );
}

export default function DashboardView() {
  const stats = useSection('stats');
  return (
    <main className="page dash">
      <Greeting />
      <div className="dash-grid">
        <div className="dash-main">
          <Pipeline stats={stats} />
          <RecentLeads />
        </div>
        <aside className="dash-side">
          <AgentControl />
          <SourceList stats={stats} />
        </aside>
      </div>
    </main>
  );
}
