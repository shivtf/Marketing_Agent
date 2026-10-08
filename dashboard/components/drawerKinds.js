// What the shared drawer shows for each kind of item. Each kind supplies what backs Previous/Next, either
//   paged    -> a paged list (useList): Previous/Next step through the page on screen, or
//   section + list(sectionData, leadsFilter, positiveView) -> items for Previous/Next,
// and load(id) -> detail
//   describe(detail) -> { title, badge?, rows[], action?, bodyTitle?, body?, bodyBox? }
import { Icon } from './Icon';
import { Badge, StatusBadge, SourceCell, ExtLink, MetaRow } from './ui';
import { pad, fmtDate, fmtDay, toneOf, REPLY_LABELS, PLAN_STATUS } from '@/core/format';
import { visiblePositive } from './DataProvider';
import * as api from '@/core/api';

const ActionButton = ({ onClick, icon, children }) => (
  <button className="btn outline block" onClick={onClick}><Icon name={icon} /> {children}</button>
);

export function getKinds(goto) {
  const lead = {
    paged: 'leads',
    heading: 'Lead Details',
    load: api.getLead,
    describe: (d) => {
      const c = d.conversation;
      return {
        title: `Lead #${pad(d.number)}`,
        badge: <StatusBadge text={d.status} />,
        rows: [
          <MetaRow key="name" k="Name">{d.name}</MetaRow>,
          <MetaRow key="title" k="Job Title">{d.title}</MetaRow>,
          <MetaRow key="co" k="Company"><ExtLink href={d.companyUrl}>{d.company}</ExtLink></MetaRow>,
          <MetaRow key="about" k="What they do">{d.about || '—'}</MetaRow>,
          <MetaRow key="src" k="Source">
            <SourceCell source={d.source} />
            <div className="profile-link"><ExtLink href={d.profileUrl}>View profile</ExtLink></div>
          </MetaRow>,
          <MetaRow key="mail" k="Email"><a className="mail-link" href={`mailto:${d.email}`}><Icon name="mail" />{d.email}</a></MetaRow>,
          <MetaRow key="added" k="Date Added">{fmtDate(d.addedAt)}</MetaRow>,
          <MetaRow key="status" k="Status"><StatusBadge text={d.status} /></MetaRow>,
          <MetaRow key="last" k="Last Contact Date">{fmtDate(d.lastContactAt)}</MetaRow>,
        ],
        action: c
          ? <ActionButton icon="mail" onClick={() => goto('history', c.type, c.id)}>Open email conversation</ActionButton>
          : <div className="muted small">No email conversation yet.</div>,
        bodyTitle: 'Notes', body: d.notes, bodyBox: true,
      };
    },
  };

  // Same drawer as a lead, opened from a Positive Leads section: Previous/Next stays in that section
  // (positive / review / questions, with the page's search and sort) and the latest reply's label
  // and any review reason are shown.
  const fromPositivePage = (group) => ({
    ...lead,
    paged: null,
    section: 'positive',
    list: (positive, _filter, view) => visiblePositive(positive[group], view),
    describe: (d) => {
      const v = lead.describe(d);
      const text = REPLY_LABELS[d.replyLabel];
      const extra = [
        <MetaRow key="label" k="Latest Reply">
          {text ? <Badge text={text} tone={toneOf(text)} /> : <span className="muted">—</span>}
        </MetaRow>,
        ...(d.reviewReason ? [
          <MetaRow key="review" k="Needs Review">
            <Badge text="Needs review" tone={toneOf('Needs review')} /> <span className="muted small">{d.reviewReason}</span>
          </MetaRow>,
        ] : []),
      ];
      return { ...v, rows: [...v.rows.slice(0, 7), ...extra, ...v.rows.slice(7)] };
    },
  });
  const positiveLead = fromPositivePage('positive');
  const reviewLead = fromPositivePage('review');
  const questionLead = fromPositivePage('questions');

  const sent = {
    paged: 'sent',
    heading: 'Email Details',
    load: api.getSentEmail,
    describe: (d) => ({
      title: `Email #${pad(d.number)}`,
      badge: <Badge text={d.deliveryStatus} tone={toneOf(d.deliveryStatus)} />,
      rows: [
        <MetaRow key="from" k="From">{d.from}</MetaRow>,
        <MetaRow key="to" k="To">{d.to}</MetaRow>,
        <MetaRow key="subj" k="Subject">{d.subject}</MetaRow>,
        <MetaRow key="sent" k="Date/Time Sent">{fmtDate(d.sentAt)}</MetaRow>,
        <MetaRow key="del" k="Delivery Status"><Badge text={d.deliveryStatus} tone={toneOf(d.deliveryStatus)} /></MetaRow>,
        <MetaRow key="reply" k="Reply Status">
          {d.replyId ? <Badge text="Replied" tone="green" /> : <Badge text="No reply" tone="gray" />}
        </MetaRow>,
      ],
      action: d.replyId
        ? <ActionButton icon="ext" onClick={() => goto('history', 'reply', d.replyId)}>Open linked reply</ActionButton>
        : null,
      bodyTitle: 'Email Body', body: d.body,
    }),
  };

  const reply = {
    paged: 'replies',
    heading: 'Reply Details',
    load: api.getReply,
    describe: (d) => {
      const o = d.originalEmail;
      return {
        title: `Reply #${pad(d.number)}`,
        badge: <StatusBadge text="Replied" />,
        rows: [
          <MetaRow key="from" k="From">{d.senderName}<div className="muted small">{d.senderEmail}</div></MetaRow>,
          <MetaRow key="to" k="To">{d.to}</MetaRow>,
          <MetaRow key="subj" k="Subject">{d.subject}</MetaRow>,
          <MetaRow key="recv" k="Date/Time Received">{fmtDate(d.receivedAt)}</MetaRow>,
        ],
        // A reply may not be linked to one of our emails (e.g. it arrived on a new thread).
        action: o ? (
          <>
            <div className="linked-label">In reply to</div>
            <div className="linked"><b>Email #{pad(o.number)}</b><span className="muted">{o.subject}</span></div>
            <ActionButton icon="ext" onClick={() => goto('history', 'sent', o.id)}>Open original email</ActionButton>
          </>
        ) : <div className="muted small">Not linked to a sent email.</div>,
        bodyTitle: 'Reply Body', body: d.body,
      };
    },
  };

  const blog = {
    paged: 'blogs',
    heading: 'Blog Details',
    load: api.getBlog,
    describe: (d) => {
      const posted = d.status === 'Posted';
      return {
        title: `Blog #${pad(d.number)}`,
        badge: <StatusBadge text={d.status} />,
        rows: [
          <MetaRow key="title" k="Title"><b>{d.title}</b></MetaRow>,
          ...(posted ? [
            <MetaRow key="on" k="Posted On">
              <a className="src" href={d.url} target="_blank" rel="noopener noreferrer">
                <Icon name={d.site} />{d.site} <Icon name="ext" />
              </a>
            </MetaRow>,
            <MetaRow key="at" k="Date/Time Posted">{fmtDate(d.postedAt)}</MetaRow>,
          ] : []),
        ],
        action: posted ? (
          <a className="btn outline block" href={d.url} target="_blank" rel="noopener noreferrer">
            <Icon name="ext" /> View live post
          </a>
        ) : null,
        bodyTitle: 'Content', body: `## ${d.title}\n\n${(d.content || '').replace(/^## /gm, '### ')}`,
      };
    },
  };

  // A blog brief from the Blog Plan (uploaded JSON). Previous/Next follow the schedule on the Blogs page.
  const plan = {
    section: 'plan',
    list: (data) => data?.items || [],
    heading: 'Planned Blog',
    load: api.getBlogPlanEntry,
    describe: (d) => {
      const label = PLAN_STATUS[d.status] || d.status;
      const list = (xs) => (xs?.length ? xs.join(', ') : '—');
      return {
        title: d.externalId,
        badge: <StatusBadge text={label} />,
        rows: [
          <MetaRow key="topic" k="Topic"><b>{d.topic}</b></MetaRow>,
          <MetaRow key="date" k="Publish Date">{fmtDay(d.publishDate, 'long')}</MetaRow>,
          <MetaRow key="cat" k="Category">{d.category}</MetaRow>,
          <MetaRow key="kw" k="Keywords">{list(d.keywords)}</MetaRow>,
          <MetaRow key="tone" k="Tone">{d.tone || '—'}</MetaRow>,
          <MetaRow key="len" k="Length">{d.length || '—'}</MetaRow>,
          <MetaRow key="ver" k="Target Versions">{list(d.targetVersions)}</MetaRow>,
          <MetaRow key="refs" k="References">
            {d.referenceUrls?.length
              ? <ul className="ref-list">{d.referenceUrls.map((u) => <li key={u}><ExtLink href={u}>{u.replace(/^https?:\/\//, '')}</ExtLink></li>)}</ul>
              : '—'}
          </MetaRow>,
          <MetaRow key="by" k="Uploaded By">{d.uploadedBy || '—'}{d.updatedAt && <div className="muted small">{fmtDate(d.updatedAt)}</div>}</MetaRow>,
        ],
        action: d.postUrl
          ? <a className="btn outline block" href={d.postUrl} target="_blank" rel="noopener noreferrer"><Icon name="ext" /> View the posted blog</a>
          : <div className="muted small">{d.postId ? 'Written, not posted yet.' : 'Not written yet. Writing and posting from the plan are not automatic yet.'}</div>,
      };
    },
  };

  return { lead, positiveLead, reviewLead, questionLead, sent, reply, blog, plan };
}
