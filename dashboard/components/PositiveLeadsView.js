'use client';
// Page 4: Positive Leads. One row per person who replied, in the tab that says what to do next (core/positiveTabs.js):
//   Reply to these -> interested or asked something, and we haven't answered their latest email yet
//   Check these    -> the keywords weren't sure, or the reply may ask to stop: a person chooses a label
//   Answered       -> we replied to their latest email
//   Closed         -> said no, or asked to stop (labelled Unsubscribe, which puts them on the agent's do-not-email list)
// The backend judges every reply on its own (/leads/positive: a person's label, else the keyword score of
// app/reply_rules.py); a person's newest reply decides their tab, and their earlier replies are listed in the drawer.
// The mail agent only sends: the backend reads every reply from Gmail (Check inbox; it also runs when the page opens, at
// most every AUTO_CHECK_MINUTES).
// The selected tab lives in the URL (?tab=check) so reloads, Back and shared links keep it.
// Search (name, company, reply text) and sort apply to the selected tab and to the drawer's Previous/Next.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { OpenRow } from './OpenRow';
import { useLeadsFilter, useSection, visiblePositive } from './DataProvider';
import { Badge, DataTable, StatCards } from './ui';
import { Icon } from './Icon';
import { checkInbox } from '@/core/api';
import { fmtDate, daysSince } from '@/core/format';
import { byPerson, OVERDUE_DAYS, TABS, whyOf } from '@/core/positiveTabs';

const AUTO_CHECK_MINUTES = 5; // opening the page reads Gmail again only after this long
let lastAutoCheck = 0; // per browser tab, so moving between pages doesn't read Gmail every time
let lastCheck = null; // { at, result }: the last Gmail check in this browser tab, shown when the page opens again

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function PositiveStatCards({ section, tabs }) {
  const { status, data, reload } = section;
  // Every number counts people. A lead is interested when they sent a positive email and have not said no since: a
  // later question or unclear email keeps them interested, a later "not interested" or "unsubscribe" does not.
  const lastYes = new Map(); // lead -> when they last wrote a positive email
  const lastNo = new Map(); // lead -> when they last said no or asked to stop
  for (const [key, seen] of [['positive', lastYes], ['notInterested', lastNo], ['unsubscribe', lastNo]]) {
    for (const l of data[key]) if (!(seen.get(l.leadId) >= l.repliedAt)) seen.set(l.leadId, l.repliedAt);
  }
  const interested = [...lastYes].filter(([lead, at]) => !(lastNo.get(lead) > at)).length;
  const rate = data.repliedLeads ? `${Math.round((interested / data.repliedLeads) * 100)}%` : '—';
  const overdue = tabs.reply.filter((l) => daysSince(l.repliedAt) >= OVERDUE_DAYS).length;
  return (
    <StatCards
      items={[
        { label: 'To reply', icon: 'mail', tone: overdue ? 'red' : 'amber', value: tabs.reply.length,
          sub: overdue ? `${overdue} waiting ${OVERDUE_DAYS}+ days` : 'Nobody waiting long', status, onRetry: reload },
        // repliedLeads: the same count as the Dashboard's Responses (every lead that replied in person).
        { label: 'Interested', icon: 'check', tone: 'green', value: interested,
          sub: `of ${plural(data.repliedLeads, 'lead')} who replied`, status, onRetry: reload },
        { label: 'Positive rate', icon: 'bolt', tone: 'lavender', value: rate, sub: 'of leads who replied', status,
          onRetry: reload },
      ]}
    />
  );
}

function TabChips({ tabs, ready, tab, onSelect }) {
  return (
    <div className="chip-group" role="tablist" aria-label="What to do">
      {TABS.map((t) => {
        const on = t.key === tab.key;
        return (
          <button key={t.key} className={`chip${on ? ' active' : ''}`} role="tab" aria-selected={on}
            onClick={() => onSelect(t)}>
            {t.label}{ready && <span className="chip-count">{tabs[t.key].length}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Why they are in this tab, in plain words; the score and matched phrases are in the tooltip and the drawer.
function Why({ lead }) {
  const why = whyOf(lead);
  return (
    <>
      <Badge text={why.text} tone={why.tone} title={why.title} />
      {lead.labelledByPerson && <div className="muted small">Labelled by a person</div>}
    </>
  );
}

// How long they have waited for our answer, or what happened instead.
function Waiting({ lead, tab }) {
  if (tab === 'answered') {
    return <><Badge text="Answered" tone="green" /><div className="muted small">{fmtDate(lead.answeredAt, 'date')}</div></>;
  }
  if (tab === 'closed') return <span className="muted small">No answer needed</span>;
  const days = daysSince(lead.repliedAt);
  return (
    <Badge text={days === 0 ? 'today' : plural(days, 'day')} tone={days >= OVERDUE_DAYS ? 'red' : 'amber'}
      title={`Replied ${fmtDate(lead.repliedAt, 'table')}`} />
  );
}

const SORT_OPTIONS = [
  { value: 'followup', label: 'Most urgent first' },
  { value: 'newest', label: 'Newest reply' },
  { value: 'oldest', label: 'Oldest reply' },
  { value: 'name', label: 'Name A–Z' },
];

function SearchAndSort({ view, setView }) {
  return (
    <>
      <input
        className="search-input"
        type="search"
        placeholder="Search name, company or reply"
        aria-label="Search leads"
        value={view.q}
        onChange={(e) => setView((v) => ({ ...v, q: e.target.value }))}
      />
      <select
        className="select"
        aria-label="Sort leads"
        value={view.sort}
        onChange={(e) => setView((v) => ({ ...v, sort: e.target.value }))}
      >
        {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </>
  );
}

// What the last Gmail check found (shown as the "Last checked" tooltip).
function checkText(r) {
  if (!r.since) return 'No outreach email has been sent yet, so there are no replies to look for.';
  const found = r.newReplies ? `${r.newReplies} new repl${r.newReplies === 1 ? 'y' : 'ies'} from leads` : 'no new replies from leads';
  const more = r.remaining ? ` ${plural(r.remaining, 'more email')} will be read on the next check.` : '';
  const gone = r.repliesWithoutLead
    ? ` ${plural(r.repliesWithoutLead, 'saved reply')} ${r.repliesWithoutLead === 1 ? 'is' : 'are'} from a lead that no longer exists, so not listed.`
    : '';
  return `Checked ${plural(r.checked, 'email')} in Gmail since ${fmtDate(r.since, 'date')}: ${found}.${more}${gone}`;
}

const ago = (at) => {
  const min = Math.floor((Date.now() - at) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : fmtDate(new Date(at).toISOString(), 'table');
};

// Reads new replies from Gmail, on click and when the page opens. onDone reloads the lists.
function useInboxCheck(onDone) {
  const [state, setState] = useState({ busy: false, last: lastCheck, error: null });
  const done = useRef(onDone);
  done.current = onDone;
  const run = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const result = await checkInbox();
      lastCheck = { at: Date.now(), result };
      setState({ busy: false, last: lastCheck, error: null });
      if (result.newReplies || result.followUpsChecked) done.current();
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message }));
    }
  }, []);
  useEffect(() => {
    if (Date.now() - lastAutoCheck < AUTO_CHECK_MINUTES * 60_000) return;
    lastAutoCheck = Date.now();
    run();
  }, [run]);
  // "2 min ago" moves on by itself.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return { ...state, run };
}

function InboxCheck({ check }) {
  const { busy, last, run } = check;
  return (
    <div className="inbox-status">
      {last && <span className="muted small" title={checkText(last.result)}>Last checked {ago(last.at)}</span>}
      <button className="btn small-btn" type="button" onClick={run} disabled={busy}>
        <Icon name="mail" /> {busy ? 'Checking Gmail…' : 'Check inbox'}
      </button>
    </div>
  );
}

// Only what needs saying: a failed check, or mail left for the next check.
function InboxNote({ check }) {
  if (check.error) return <div className="info-note warn" role="status">Could not read Gmail: {check.error}</div>;
  const r = check.last?.result;
  if (r && (!r.since || r.remaining)) return <div className="info-note" role="status">{checkText(r)}</div>;
  return null;
}

export default function PositiveLeadsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const section = useSection('positive');
  const { status, data, reload } = section;
  const { positiveView, setPositiveView } = useLeadsFilter();
  const check = useInboxCheck(reload);
  const tabs = useMemo(() => byPerson(data), [data]);

  const tab = TABS.find((t) => t.key === params.get('tab')) || TABS[0];
  // The drawer's Previous/Next steps through the same tab.
  useEffect(() => {
    if (positiveView.tab !== tab.key) setPositiveView((v) => ({ ...v, tab: tab.key }));
  }, [tab.key, positiveView.tab, setPositiveView]);
  const select = (t) => {
    const query = t.key === TABS[0].key ? '' : `?tab=${t.key}`;
    router.replace(`${pathname}${query}`, { scroll: false });
  };
  const all = tabs[tab.key];
  const list = visiblePositive(all, positiveView);
  const searching = positiveView.q.trim() !== '';

  return (
    <main className="page">
      <div className="page-head page-head-row">
        <div>
          <h1 className="page-title">Positive Leads</h1>
          <p className="muted">Who to answer and what to check.</p>
        </div>
        <InboxCheck check={check} />
      </div>
      <PositiveStatCards section={section} tabs={tabs} />
      <div className="card">
        <div className="filters">
          <TabChips tabs={tabs} ready={status === 'ready'} tab={tab} onSelect={select} />
          <div className="filters-gap" />
          <SearchAndSort view={positiveView} setView={setPositiveView} />
        </div>
        <p className="muted small group-hint">{tab.hint}</p>
        <InboxNote check={check} />
        <DataTable
          status={status}
          emptyIcon={tab.icon}
          emptyText={searching && all.length ? 'No leads match your search' : tab.empty}
          what="positive leads"
          onRetry={reload}
          head={(
            <>
              <th>Lead</th><th>Their reply</th><th>Why</th>
              <th>{tab.key === 'answered' || tab.key === 'closed' ? 'Status' : 'Waiting'}</th>
              <th className="view" aria-label="Open" />
            </>
          )}
          rows={list.map((l) => (
            <OpenRow key={l.id} kind="personLead" id={l.id}>
              <td className="lead-cell">
                <div className="name">{l.name}</div>
                <div className="muted small">{l.company}</div>
                {l.earlier.length > 0 && (
                  <div className="muted small">+{l.earlier.length} earlier repl{l.earlier.length === 1 ? 'y' : 'ies'}</div>
                )}
              </td>
              <td className="reply-cell">
                {l.preview ? <div className="reply-preview">“{l.preview}”</div> : <span className="muted">—</span>}
              </td>
              <td><Why lead={l} /></td>
              <td><Waiting lead={l} tab={tab.key} /></td>
              <td className="view"><Icon name="chevR" /></td>
            </OpenRow>
          ))}
        />
      </div>
    </main>
  );
}
