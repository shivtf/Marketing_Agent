'use client';
// Needs Contact: qualified companies the Marketing Agent could not find an email for (backend /needs-contact).
// A person looks the company up, presses Edit and types an email (and, if known, a name and role). The agent then writes
// the email and posts it to Slack for approval; nothing is sent from here. Everyone signed in can do this: the Slack
// approval is still the gate for every email.
import { useEffect, useRef, useState } from 'react';
import { StatCards, CardHead, DataTable, ExtLink } from './ui';
import { Icon } from './Icon';
import { useSection, useUpdateSection } from './DataProvider';
import { addContact } from '@/core/api';
import { fmtDate } from '@/core/format';

// The agent's note reads "no contact after 3 attempts: <why>". The page already says no contact was found, so keep the why.
const reasonText = (note) => (note || '').replace(/^no contact after \d+ attempts?:\s*/i, '') || 'No public business email found';

const EMAIL_SHAPE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function ContactDialog({ lead, onClose, onSaved }) {
  const ref = useRef(null);
  const [form, setForm] = useState({ email: '', name: '', role: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);

  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setError(''); };

  async function onSubmit(e) {
    e.preventDefault();
    const email = form.email.trim();
    if (!EMAIL_SHAPE.test(email)) return setError('Enter a valid email address, like name@company.com.');
    setBusy(true);
    try {
      await addContact(lead.id, { email, name: form.name.trim() || null, role: form.role.trim() || null });
      onSaved(lead);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="confirm campaign-dialog"
      aria-labelledby="contact-dialog-title"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} // click outside the card = backdrop
    >
      <form className="confirm-card campaign-form" noValidate onSubmit={onSubmit}>
        <div className="campaign-dialog-head">
          <h2 id="contact-dialog-title" className="confirm-title">Add contact for {lead.company}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" disabled={busy}><Icon name="close" /></button>
        </div>
        <p className="muted small">
          The agent will write the email for this company and send it to Slack for approval. Nothing is emailed until someone
          approves it there.
        </p>
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set('email')} maxLength={254} autoComplete="off" placeholder="name@company.com" autoFocus required />
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input value={form.name} onChange={set('name')} maxLength={120} autoComplete="off" placeholder="Used in the greeting" />
        </label>
        <label className="field">
          <span>Role (optional)</span>
          <input value={form.role} onChange={set('role')} maxLength={120} autoComplete="off" placeholder="e.g. CTO" />
        </label>
        {error && <div className="confirm-error" role="alert">{error}</div>}
        <div className="confirm-actions">
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn primary${busy ? ' loading' : ''}`} type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save and create email'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function NeedsContactView() {
  const section = useSection('needsContact');
  const update = useUpdateSection();
  const { status, data, reload } = section;
  const [editing, setEditing] = useState(null); // the lead being edited
  const [saved, setSaved] = useState('');

  // The company leaves the list at once; the agent picks it up from the database.
  const onSaved = (lead) => {
    update('needsContact', (d) => ({ ...d, items: d.items.filter((x) => x.id !== lead.id), total: Math.max(0, d.total - 1) }));
    setSaved(`${lead.company}: saved. The agent is writing the email and will post it to Slack for approval shortly.`);
    setEditing(null);
  };

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">Needs Contact</h1>
        <p className="muted">Qualified companies the agent could not find an email for. Add one and the agent writes the email for approval.</p>
      </div>
      <StatCards items={[{ label: 'Waiting for a contact', icon: 'mail', tone: 'amber', value: data.total, status, onRetry: reload }]} />
      <div className="card">
        <CardHead icon="mail" title="Companies without contact details" />
        {saved && <div className="info-note" role="status">{saved}</div>}
        <DataTable
          status={status}
          emptyIcon="check"
          emptyText="Every qualified company has a contact"
          what="companies"
          onRetry={reload}
          head={<><th>Company</th><th>About</th><th>Score</th><th>Why no contact</th><th>Found</th><th className="needs-edit"><span className="sr-only">Edit</span></th></>}
          rows={data.items.map((l) => (
            <tr key={l.id}>
              <td>
                <div className="name">{l.company}</div>
                <div className="muted small"><ExtLink href={l.website}>{l.website.replace(/^https?:\/\//, '')}</ExtLink></div>
              </td>
              <td><div className="ellip preview">{l.about || <span className="muted">—</span>}</div></td>
              <td className="num">{l.score}</td>
              <td>
                <div className="small needs-reason">{reasonText(l.reason)}</div>
                {/^https?:\/\//i.test(l.formUrl || '') && <div className="small"><ExtLink href={l.formUrl}>Contact form</ExtLink></div>}
              </td>
              <td className="muted when">{fmtDate(l.since, 'table')}</td>
              <td className="needs-edit">
                <button className="btn" type="button" onClick={() => { setSaved(''); setEditing(l); }} aria-label={`Add contact for ${l.company}`}>
                  <Icon name="edit" /> Edit
                </button>
              </td>
            </tr>
          ))}
        />
      </div>
      {editing && <ContactDialog lead={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </main>
  );
}
