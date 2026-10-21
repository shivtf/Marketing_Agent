// What the shared drawer shows for each kind of item. Each kind supplies what backs Previous/Next, either
//   paged    -> a paged list (useList): Previous/Next step through the page on screen, or
//   section + list(sectionData, leadsFilter, positiveView) -> items for Previous/Next,
// and load(id) -> detail
//   describe(detail) -> { title, badge?, rows[], action?, bodyTitle?, body?, bodyBox?, markdown? }  (no body = no body section;
//   markdown: the body is markdown, e.g. a blog, not an email)
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from './Icon';
import { Badge, StatusBadge, SourceCell, ExtLink, MetaRow } from './ui';
import { pad, fmtDate, toneOf, REPLY_LABELS, replyLabel, scoreTone, scoreHitsText } from '@/core/format';
import { visiblePositive } from './DataProvider';
import * as api from '@/core/api';

const ActionButton = ({ onClick, icon, children }) => (
  <button className="btn outline block" onClick={onClick}><Icon name={icon} /> {children}</button>
);

// "Label this reply": a person's label for the reply the lead is judged on. The lead moves to that group, and the
// labels become the reviewed examples a future classifier can learn from. Unsubscribe also puts the lead on the mail
// agent's do-not-email list (removing the label takes them off again); the agent sees no other label.
function LabelReply({ d }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(d.replyLabel || '');
  const [state, setState] = useState({ busy: false, error: null });
  const save = async (next) => {
    setState({ busy: true, error: null });
    try {
      await api.labelReply({ replyId: d.latestReply.id, label: next });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['section', 'positive'] }),
        qc.invalidateQueries({ queryKey: ['detail'] }),
      ]);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  };
  const mine = d.labelledBy;
  return (
    <div className="label-reply">
      <div className="label-reply-row">
        <select className="select" aria-label="Label this reply" value={label} disabled={state.busy}
          onChange={(e) => setLabel(e.target.value)}>
          {!d.replyLabel && <option value="" disabled>Choose a label</option>}
          {Object.entries(REPLY_LABELS).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
        </select>
        <button className="btn small-btn primary" type="button" disabled={state.busy || !label || label === d.replyLabel}
          onClick={() => save(label)}>
          {state.busy ? 'Saving…' : 'Save'}
        </button>
        {mine && <button className="btn small-btn" type="button" disabled={state.busy} onClick={() => save(null)}>Remove</button>}
      </div>
      <div className="muted small">
        {mine
          ? `Labelled by ${mine.by || 'a person'} on ${fmtDate(mine.at, 'date')}.`
          : 'Read the reply below, then choose what it means.'}
      </div>
      {state.error && <div className="confirm-error" role="alert">{state.error}</div>}
    </div>
  );
}

// The lead (company) an email or reply belongs to.
const LeadRow = ({ d }) => <MetaRow key="lead" k="Lead">{d.company || <span className="muted">Unknown company</span>}</MetaRow>;

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
          <MetaRow key="mail" k="Email">
            {d.email
              ? <a className="mail-link" href={`mailto:${d.email}`}><Icon name="mail" />{d.email}</a>
              : <span className="muted small">No contact yet: add one on the Needs Contact page.</span>}
          </MetaRow>,
          <MetaRow key="added" k="Date Added">{fmtDate(d.addedAt)}</MetaRow>,
          <MetaRow key="status" k="Status"><StatusBadge text={d.status} /></MetaRow>,
          <MetaRow key="last" k="Last Contact Date">{fmtDate(d.lastContactAt)}</MetaRow>,
        ],
        action: c
          ? <ActionButton icon="mail" onClick={() => goto('history', c.type, c.id)}>Open email conversation</ActionButton>
          : <div className="muted small">No email conversation yet.</div>,
        // The reply the lead is judged on, as the person wrote it (quoted earlier mail is left out: the full thread is
        // one click away in History). Leads without a reply have no body section.
        bodyTitle: d.latestReply ? `Their latest reply · ${fmtDate(d.latestReply.receivedAt)}` : null,
        body: d.latestReply?.text ?? null,
      };
    },
  };

  // Same drawer as a lead, opened from a Positive Leads section on one reply (each reply is its own row there, so the
  // id is the reply's): Previous/Next stays in that section (with the page's search and sort), and that reply, its
  // label, score and any review reason are shown.
  const fromPositivePage = (group) => ({
    ...lead,
    paged: null,
    section: 'positive',
    load: api.getLeadByReply,
    list: (positive, _filter, view) => visiblePositive(positive[group], view),
    describe: (d) => {
      const v = { ...lead.describe(d), bodyTitle: d.latestReply ? `Their reply · ${fmtDate(d.latestReply.receivedAt)}` : null };
      const text = REPLY_LABELS[d.replyLabel];
      const extra = [
        <MetaRow key="label" k="This Reply">
          {text ? <Badge text={text} tone={toneOf(text)} /> : <Badge text="Not labelled" tone="gray" />}
        </MetaRow>,
        ...(d.score != null ? [
          <MetaRow key="score" k="Keyword Score">
            <Badge text={d.score.toFixed(2)} tone={scoreTone(d.score)} />
            <div className="muted small">
              {d.scoreHits.length ? `Matched: ${scoreHitsText(d.scoreHits)}.` : 'No keywords matched.'}
              {d.labelledBy && ' A person’s label is used instead.'}
            </div>
          </MetaRow>,
        ] : []),
        ...(d.reviewReason && d.replyGroup !== 'unsubscribe' ? [
          <MetaRow key="review" k="Needs Review">
            <Badge text="Needs review" tone={toneOf('Needs review')} /> <span className="muted small">{d.reviewReason}</span>
          </MetaRow>,
        ] : []),
        ...(d.replyLabel === 'ooo' || d.replyLabel === 'bounce' ? [
          <MetaRow key="auto" k="Not Listed">
            <span className="small">
              Automatic mail is left out of Positive Leads.
              {d.labelledBy ? ' To bring it back, choose another label or remove this one.' : ''}
            </span>
          </MetaRow>,
        ] : []),
        ...(d.replyGroup === 'unsubscribe' ? [
          <MetaRow key="unsub" k="Unsubscribe">
            <span className="small">
              {d.doNotEmail === true
                ? 'On the mail agent’s do-not-email list: it won’t email them again.'
                : d.doNotEmail === false
                  ? 'Not on the mail agent’s do-not-email list yet: label this reply Unsubscribe to stop its emails.'
                  : 'Unsubscribe requested — label this reply Unsubscribe to stop the mail agent’s emails.'}
              {d.reviewReason && <span className="muted"> ({d.reviewReason}.)</span>}
            </span>
          </MetaRow>,
        ] : []),
        ...(d.latestReply ? [
          // key: a fresh control for each reply, so stepping to the next lead doesn't carry this one's choice.
          <MetaRow key="labelit" k="Label This Reply"><LabelReply key={d.latestReply.id} d={d} /></MetaRow>,
        ] : []),
      ];
      return { ...v, rows: [...v.rows.slice(0, 7), ...extra, ...v.rows.slice(7)] };
    },
  });
  const positiveLead = fromPositivePage('positive');
  const reviewLead = fromPositivePage('review');
  const questionLead = fromPositivePage('questions');
  const notInterestedLead = fromPositivePage('notInterested');
  const unsubscribeLead = fromPositivePage('unsubscribe');

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
        <MetaRow key="del" k="Status"><Badge text={d.deliveryStatus} tone={toneOf(d.deliveryStatus)} /></MetaRow>,
        <MetaRow key="reply" k="Reply Status">
          {d.replyId ? <Badge text="Replied" tone="green" /> : <Badge text="No reply" tone="gray" />}
        </MetaRow>,
        <LeadRow key="lead" d={d} />,
      ],
      action: (
        <>
          {d.replyId && <ActionButton icon="ext" onClick={() => goto('history', 'reply', d.replyId)}>Open linked reply</ActionButton>}
          {d.leadId && <ActionButton icon="user" onClick={() => goto('dashboard', 'lead', d.leadId)}>Open lead</ActionButton>}
        </>
      ),
      bodyTitle: 'Email Body', body: d.body,
    }),
  };

  // Opened only from a sent email ("Open linked reply"): there is no replies list behind it, so no Previous/Next.
  const reply = {
    list: () => [],
    heading: 'Reply Details',
    load: api.getReply,
    describe: (d) => {
      const o = d.originalEmail;
      return {
        title: `Reply #${pad(d.number)}`,
        badge: <Badge text={replyLabel(d.label)} tone={toneOf(replyLabel(d.label))} />,
        rows: [
          <MetaRow key="from" k="From">{d.senderName}<div className="muted small">{d.senderEmail}</div></MetaRow>,
          <MetaRow key="to" k="To">{d.to}</MetaRow>,
          <MetaRow key="subj" k="Subject">{d.subject}</MetaRow>,
          <MetaRow key="recv" k="Date/Time Received">{fmtDate(d.receivedAt)}</MetaRow>,
          <MetaRow key="label" k="Reply Type"><Badge text={replyLabel(d.label)} tone={toneOf(replyLabel(d.label))} /></MetaRow>,
          <LeadRow key="lead" d={d} />,
        ],
        // A reply may not be linked to one of our emails (e.g. it arrived on a new thread).
        action: (
          <>
            {o ? (
              <>
                <div className="linked-label">In reply to</div>
                <div className="linked"><b>Email #{pad(o.number)}</b><span className="muted">{o.subject}</span></div>
                <ActionButton icon="ext" onClick={() => goto('history', 'sent', o.id)}>Open original email</ActionButton>
              </>
            ) : <div className="muted small">Not linked to a sent email.</div>}
            {d.leadId && <ActionButton icon="user" onClick={() => goto('dashboard', 'lead', d.leadId)}>Open lead</ActionButton>}
          </>
        ),
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
        bodyTitle: 'Content', body: d.content || '', markdown: true,
      };
    },
  };

  return { lead, positiveLead, reviewLead, questionLead, notInterestedLead, unsubscribeLead, sent, reply, blog };
}
