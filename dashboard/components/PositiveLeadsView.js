'use client';
// Page 4: Positive Leads. Each lead is judged on its latest reply written by a person (backend /leads/positive):
//   Positive      -> classified interested with confidence
//   Needs review  -> the classifier wasn't sure (interested, question or a doubtful "no")
//   Questions     -> asked something (scope, pricing, process) before deciding
//   Not interested -> a confident "no": listed so a misread "yes" can still be spotted
//   Unsubscribe   -> asked to stop (or seems to): the mail agent has to act on it; the dashboard can't
// Replies come from the mail agent, or from Gmail read by the dashboard itself (Check inbox; it also runs when the page
// opens, at most every AUTO_CHECK_MINUTES). Those have no label until a person gives one in the drawer.
// Within each group, leads still waiting for our answer come first, longest-waiting on top.
// The selected group lives in the URL (?group=review) so reloads, Back and shared links keep it.
// Search (name, company, reply text) and sort apply to the selected group and to the drawer's Previous/Next.
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { OpenRow } from './OpenRow';
import { useLeadsFilter, useSection, visiblePositive } from './DataProvider';
import { Badge, CardHead, SourceCell, ViewCell, DataTable, StatCards } from './ui';
import { Icon } from './Icon';
import { checkInbox } from '@/core/api';
import { pad, fmtDate, toneOf, daysSince, REPLY_LABELS } from '@/core/format';

const OVERDUE_DAYS = 3; // unanswered for this long -> shown in red
const STUCK_HOURS = 3; // a reply unclassified for this long: the agent is probably stopped or stuck
const AUTO_CHECK_MINUTES = 5; // opening the page reads Gmail again only after this long
let lastAutoCheck = 0; // per browser tab, so moving between pages doesn't read Gmail every time

const GROUPS = [
  { key: 'positive', label: 'Positive', kind: 'positiveLead', icon: 'check', empty: 'No positive leads yet',
    hint: 'Replied with interest: they want a call, more details or to move forward.' },
  { key: 'review', label: 'Needs review', kind: 'reviewLead', icon: 'alert', empty: 'Nothing to review',
    hint: 'The classifier was not sure, or the reply was read from Gmail and nobody has labelled it yet. Open each one and choose a label; they are not counted as positive.' },
  { key: 'questions', label: 'Questions', kind: 'questionLead', icon: 'chat', empty: 'No open questions',
    hint: 'Asked about scope, pricing or process before deciding. Answer these quickly; they are not counted as positive.' },
  { key: 'notInterested', label: 'Not interested', kind: 'notInterestedLead', icon: 'close', empty: 'No one has said no',
    hint: 'Said no, so the agent closed them and no answer is needed. Skim these in case a reply was misread.' },
  { key: 'unsubscribe', label: 'Unsubscribe', kind: 'unsubscribeLead', icon: 'close', empty: 'Nobody has asked to stop',
    hint: 'Unsubscribe requested — action required in the mail agent to stop future emails. The dashboard does not stop them.' },
];

function PositiveStatCards({ section }) {
  const { status, data, reload } = section;
  const positive = data.positive.length;
  const rate = data.repliedLeads ? `${((positive / data.repliedLeads) * 100).toFixed(1)}%` : '—';
  return (
    <StatCards
      items={[
        { label: 'Positive Leads', icon: 'check', tone: 'green', value: positive, status, onRetry: reload },
        // Same count as the Dashboard's Responses: every lead that replied in person, classified or not.
        { label: 'Leads Replied', icon: 'chat', value: data.repliedLeads, status, onRetry: reload },
        { label: 'Positive Rate', icon: 'bolt', tone: 'lavender', value: rate, status, onRetry: reload },
      ]}
    />
  );
}

function GroupChips({ data, ready, group, onSelect }) {
  return (
    <div className="chip-group" role="tablist" aria-label="Lead groups">
      {GROUPS.map((g) => {
        const on = g.key === group.key;
        return (
          <button
            key={g.key}
            className={`chip${on ? ' active' : ''}`}
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(g)}
          >
            {g.label}{ready && ` (${data[g.key].length})`}
          </button>
        );
      })}
    </div>
  );
}

// Whether we have answered the lead's latest reply, and for how long they've been waiting if not.
function FollowUp({ lead }) {
  if (lead.followUp === 'replied') {
    return (
      <>
        <Badge text="We replied" tone="green" />
        <div className="muted small">{fmtDate(lead.answeredAt, 'date')}</div>
      </>
    );
  }
  if (lead.followUp === 'queued') return <Badge text="Answer queued" tone="gray" />;
  if (lead.followUp === 'none') return <Badge text="No answer needed" tone="gray" />;
  // Read from Gmail by the dashboard only: the mail agent hasn't seen it, so nothing tells it to stop following up.
  if (lead.followUp === 'unknown') {
    return (
      <>
        <Badge text="Reply received" tone="blue" />
        <div className="muted small">Follow-up status unknown</div>
      </>
    );
  }
  const days = daysSince(lead.repliedAt);
  const text = days === 0 ? 'Waiting · today' : `Waiting ${days} day${days === 1 ? '' : 's'}`;
  return <Badge text={text} tone={days >= OVERDUE_DAYS ? 'red' : 'amber'} />;
}

const SORT_OPTIONS = [
  { value: 'followup', label: 'Follow-up first' },
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

// What the last Gmail check found, in one line.
function checkText(r) {
  const found = r.newReplies ? `${r.newReplies} new repl${r.newReplies === 1 ? 'y' : 'ies'} from leads` : 'no new replies from leads';
  const more = r.remaining ? ` ${r.remaining} more email${r.remaining === 1 ? '' : 's'} will be read on the next check.` : '';
  return `Checked Gmail: ${found}.${more}`;
}

// Reads new replies from Gmail, on click and when the page opens. onDone reloads the lists.
function useInboxCheck(onDone) {
  const [state, setState] = useState({ busy: false, result: null, error: null });
  const done = useRef(onDone);
  done.current = onDone;
  const run = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const result = await checkInbox();
      setState({ busy: false, result, error: null });
      if (result.newReplies || result.followUpsChecked) done.current();
    } catch (err) {
      setState({ busy: false, result: null, error: err.message });
    }
  }, []);
  useEffect(() => {
    if (Date.now() - lastAutoCheck < AUTO_CHECK_MINUTES * 60_000) return;
    lastAutoCheck = Date.now();
    run();
  }, [run]);
  return { ...state, run };
}

function InboxNote({ check }) {
  if (check.error) return <div className="info-note warn" role="status">Could not read Gmail: {check.error}</div>;
  if (!check.result) return null;
  return <div className="info-note" role="status">{checkText(check.result)}</div>;
}

// Replies the agent hasn't classified yet. Usually a short wait; when the oldest has waited hours, say so plainly.
function PendingNote({ count, since }) {
  if (!count) return null;
  const replies = count === 1 ? '1 reply' : `${count} replies`;
  const hours = since ? (Date.now() - new Date(since).getTime()) / 3600000 : 0;
  if (hours >= STUCK_HOURS) {
    return (
      <div className="info-note warn" role="status">
        {replies} {count === 1 ? 'has' : 'have'} been waiting to be classified since {fmtDate(since)}. The agent
        classifies replies while it runs: check that it is running.
      </div>
    );
  }
  return (
    <div className="info-note" role="status">
      {count === 1 ? '1 new reply is' : `${count} new replies are`} still being classified and will appear here shortly.
    </div>
  );
}

export default function PositiveLeadsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const section = useSection('positive');
  const { status, data, reload } = section;
  const { positiveView, setPositiveView } = useLeadsFilter();
  const check = useInboxCheck(reload);

  const group = GROUPS.find((g) => g.key === params.get('group')) || GROUPS[0];
  const select = (g) => {
    const query = g.key === GROUPS[0].key ? '' : `?group=${g.key}`;
    router.replace(`${pathname}${query}`, { scroll: false });
  };
  const reviewing = group.key === 'review' || group.key === 'unsubscribe';
  const all = data[group.key];
  const list = visiblePositive(all, positiveView);
  const searching = positiveView.q.trim() !== '';

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">Positive Leads</h1>
        <p className="muted">Leads who replied with interest, ready for follow-up.</p>
      </div>
      <PositiveStatCards section={section} />
      <div className="card">
        <CardHead icon={group.icon} title="Leads to Follow Up">
          <button className="btn small-btn inbox-check" type="button" onClick={check.run} disabled={check.busy}>
            <Icon name="mail" /> {check.busy ? 'Checking Gmail…' : 'Check inbox'}
          </button>
        </CardHead>
        <div className="filters">
          <GroupChips data={data} ready={status === 'ready'} group={group} onSelect={select} />
          <div className="filters-gap" />
          <SearchAndSort view={positiveView} setView={setPositiveView} />
        </div>
        <p className="muted small group-hint">{group.hint}</p>
        <InboxNote check={check} />
        {status === 'ready' && <PendingNote count={data.pending} since={data.pendingSince} />}
        <DataTable
          status={status}
          emptyIcon={group.icon}
          emptyText={searching && all.length ? 'No leads match your search' : group.empty}
          what="positive leads"
          onRetry={reload}
          head={(
            <>
              <th>#</th><th>Name</th><th>Source</th><th>Replied On</th><th>Follow-up</th>
              {reviewing && <th>Label / Reason</th>}
              <th>Reply Preview</th><th className="view">View</th>
            </>
          )}
          rows={list.map((l) => (
            <OpenRow key={l.id} kind={group.kind} id={l.id}>
              <td className="num">{pad(l.number)}</td>
              <td><div className="name">{l.name}</div><div className="muted small">{l.company}</div></td>
              <td><SourceCell source={l.source} /></td>
              <td className="muted when">
                {fmtDate(l.repliedAt, 'table')}
                {l.replySource === 'inbox' && <div className="small">Read from Gmail</div>}
              </td>
              <td><FollowUp lead={l} /></td>
              {reviewing && (
                <td>
                  {l.label
                    ? <Badge text={REPLY_LABELS[l.label]} tone={toneOf(REPLY_LABELS[l.label])} />
                    : <Badge text="Not labelled" tone="gray" />}
                  <div className="muted small">{l.labelledByPerson ? 'Labelled by a person' : l.reviewReason}</div>
                </td>
              )}
              <td><div className="ellip preview">{l.preview || <span className="muted">—</span>}</div></td>
              <ViewCell />
            </OpenRow>
          ))}
        />
      </div>
    </main>
  );
}
