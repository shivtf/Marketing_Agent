'use client';
// Page 4: Positive Leads (leads whose reply was classified as interested).
import { OpenRow } from './OpenRow';
import { combinedStatus, useSection } from './DataProvider';
import { CardHead, SourceCell, ViewCell, DataTable, StatCards } from './ui';
import { pad, fmtDate } from '@/core/format';

function PositiveStatCards({ positive, replies }) {
  const rate = replies.data.length ? `${((positive.data.length / replies.data.length) * 100).toFixed(1)}%` : '—';
  const retryFailed = () => [positive, replies].forEach((s) => s.status === 'error' && s.reload());
  return (
    <StatCards
      items={[
        { label: 'Positive Leads', icon: 'check', tone: 'green', value: positive.data.length,
          status: positive.status, onRetry: positive.reload },
        { label: 'Replies Received', icon: 'chat', value: replies.data.length,
          status: replies.status, onRetry: replies.reload },
        { label: 'Positive Rate', icon: 'bolt', tone: 'lavender', value: rate,
          status: combinedStatus(positive, replies), onRetry: retryFailed },
      ]}
    />
  );
}

export default function PositiveLeadsView() {
  const positive = useSection('positive');
  const replies = useSection('replies');
  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">Positive Leads</h1>
        <p className="muted">Leads who replied with interest (a call, pricing or a proposal).</p>
      </div>
      <PositiveStatCards positive={positive} replies={replies} />
      <div className="card">
        <CardHead icon="reply" title="Leads to Follow Up" />
        <DataTable
          status={positive.status}
          emptyIcon="reply"
          emptyText="No positive leads yet"
          what="positive leads"
          onRetry={positive.reload}
          head={(
            <>
              <th>#</th><th>Name</th><th>Source</th><th>Replied On</th><th>Reply Preview</th><th className="view">View</th>
            </>
          )}
          rows={positive.data.map((l) => (
            <OpenRow key={l.id} kind="positiveLead" id={l.id}>
              <td className="num">{pad(l.number)}</td>
              <td><div className="name">{l.name}</div><div className="muted small">{l.company}</div></td>
              <td><SourceCell source={l.source} /></td>
              <td className="muted when">{fmtDate(l.repliedAt, 'table')}</td>
              <td><div className="ellip preview">{l.preview}</div></td>
              <ViewCell />
            </OpenRow>
          ))}
        />
      </div>
    </main>
  );
}
