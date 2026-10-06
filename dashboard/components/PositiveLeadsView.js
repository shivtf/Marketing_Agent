'use client';
// Page 4: Positive Leads. Each lead is judged on its latest reply written by a person (backend /leads/positive):
//   Positive      -> classified interested with confidence
//   Needs review  -> the classifier wasn't sure (interested, question or a doubtful "no")
//   Questions     -> asked something (scope, pricing, process) before deciding
// Within each group, leads still waiting for our answer come first, longest-waiting on top.
// The selected group lives in the URL (?group=review) so reloads, Back and shared links keep it.
// Search (name, company, reply text) and sort apply to the selected group and to the drawer's Previous/Next.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { OpenRow } from './OpenRow';
import { useLeadsFilter, useSection, visiblePositive } from './DataProvider';
import { Badge, CardHead, SourceCell, ViewCell, DataTable, StatCards } from './ui';
import { pad, fmtDate, toneOf, daysSince, REPLY_LABELS } from '@/core/format';

const OVERDUE_DAYS = 3; // unanswered for this long -> shown in red

const GROUPS = [
  { key: 'positive', label: 'Positive', kind: 'positiveLead', icon: 'check', empty: 'No positive leads yet',
    hint: 'Replied with interest: they want a call, more details or to move forward.' },
  { key: 'review', label: 'Needs review', kind: 'reviewLead', icon: 'alert', empty: 'Nothing to review',
    hint: 'The classifier was not sure about these replies. Check them before following up; they are not counted as positive.' },
  { key: 'questions', label: 'Questions', kind: 'questionLead', icon: 'chat', empty: 'No open questions',
    hint: 'Asked about scope, pricing or process before deciding. Answer these quickly; they are not counted as positive.' },
];

function PositiveStatCards({ section }) {
  const { status, data, reload } = section;
  const positive = data.positive.length;
  const rate = data.repliedLeads ? `${((positive / data.repliedLeads) * 100).toFixed(1)}%` : '—';
  return (
    <StatCards
      items={[
        { label: 'Positive Leads', icon: 'check', tone: 'green', value: positive, status, onRetry: reload },
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

function PendingNote({ count }) {
  if (!count) return null;
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

  const group = GROUPS.find((g) => g.key === params.get('group')) || GROUPS[0];
  const select = (g) => {
    const query = g.key === GROUPS[0].key ? '' : `?group=${g.key}`;
    router.replace(`${pathname}${query}`, { scroll: false });
  };
  const reviewing = group.key === 'review';
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
        <CardHead icon={group.icon} title="Leads to Follow Up" />
        <div className="filters">
          <GroupChips data={data} ready={status === 'ready'} group={group} onSelect={select} />
          <div className="filters-gap" />
          <SearchAndSort view={positiveView} setView={setPositiveView} />
        </div>
        <p className="muted small group-hint">{group.hint}</p>
        {status === 'ready' && <PendingNote count={data.pending} />}
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
              <td className="muted when">{fmtDate(l.repliedAt, 'table')}</td>
              <td><FollowUp lead={l} /></td>
              {reviewing && (
                <td>
                  <Badge text={REPLY_LABELS[l.label]} tone={toneOf(REPLY_LABELS[l.label])} />
                  <div className="muted small">{l.reviewReason}</div>
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
