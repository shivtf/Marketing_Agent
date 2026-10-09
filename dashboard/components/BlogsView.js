'use client';
// Page 3: Blogs. Weekly Blog Files (the week's JSON, stored as is in Supabase Storage for the publishing backend, and
// which blog goes out on which day) on top, and the Blog Tracker (blogs written so far) below.
import { useEffect, useRef, useState } from 'react';
import { OpenRow } from './OpenRow';
import { useList } from './DataProvider';
import { Badge, CardHead, StatusBadge, SiteCell, ViewCell, DataTable, Pager, Skeleton, ErrorBox, EmptyBox, MetaRow, ExtLink } from './ui';
import { FormattedContent } from './FormattedContent';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { getSession, isAdmin } from '@/core/auth';
import { pad, fmtDate, fmtDay } from '@/core/format';
import { listWeeklyFiles, getWeeklyFile, uploadWeeklyFile, weekChoices, fileMonday } from '@/core/blogFiles';
import { readBlogs, checkWeek } from '@/core/weeklyBlogs';

const StatBox = ({ label, value, color }) => (
  <div className="stat-box">
    <div className="muted small"><span className="dot" style={{ background: color }} />{label}</div>
    <div className="big">{value}</div>
  </div>
);

function useIsAdmin() {
  const [admin, setAdmin] = useState(false);
  useEffect(() => { getSession().then((s) => setAdmin(isAdmin(s))); }, []);
  return admin;
}

// ---------- Weekly Blog Files: pick the week -> choose the JSON -> check it -> saved in Supabase Storage ----------
// The schedule below is read from the stored files themselves (core/weeklyBlogs.js), so it shows exactly what the
// publishing backend gets. No status: approving and posting happen in that backend.

// A dialog in the dashboard's style (built on <dialog>, like ConfirmDialog).
function ViewDialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog
      ref={ref}
      className="confirm file-view"
      aria-labelledby="file-view-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} // click outside the card = backdrop
    >
      <div className="confirm-card">
        <div className="file-view-head">
          <h2 id="file-view-title" className="confirm-title">{title}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" autoFocus><Icon name="close" /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

// One blog from a stored file: its details and its text.
function BlogViewer({ name, n, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    getWeeklyFile(name)
      .then(({ text }) => {
        const blog = readBlogs(JSON.parse(text)).blogs?.find((b) => b.n === n);
        setState(blog ? { status: 'ready', blog } : { status: 'error', message: 'This blog is no longer in the file.' });
      })
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, [name, n]);
  const b = state.blog;
  const join = (xs) => (xs?.length ? xs.join(', ') : '—');
  return (
    <ViewDialog title={b ? b.topic || b.id : 'Blog'} onClose={onClose}>
      {state.status === 'loading' && <Skeleton rows={6} />}
      {state.status === 'error' && <div className="notice">{state.message}</div>}
      {b && (
        <div className="file-view-body blog-view">
          <div className="meta">
            <MetaRow k="ID"><span className="mono">{b.id || '—'}</span></MetaRow>
            <MetaRow k="Publish Date">{b.publishDate ? fmtDay(b.publishDate, 'long') : '—'}</MetaRow>
            <MetaRow k="Category">{b.category || '—'}</MetaRow>
            <MetaRow k="Keywords">{join(b.keywords)}</MetaRow>
            <MetaRow k="Tone">{b.tone || '—'}</MetaRow>
            <MetaRow k="Length">{b.length || '—'}</MetaRow>
            <MetaRow k="Target Versions">{join(b.targetVersions)}</MetaRow>
            <MetaRow k="References">
              {b.referenceUrls.length
                ? <ul className="ref-list">{b.referenceUrls.map((u) => <li key={u}><ExtLink href={u}>{u.replace(/^https?:\/\//, '')}</ExtLink></li>)}</ul>
                : '—'}
            </MetaRow>
            <MetaRow k="File">{name}</MetaRow>
          </div>
          <h3 className="body-title">Content{b.contentFormat ? ` (${b.contentFormat})` : ''}</h3>
          {b.content.trim()
            ? <div className="content"><FormattedContent text={b.content.replace(/^# /gm, '## ')} /></div>
            : <div className="muted">No content in the file.</div>}
        </div>
      )}
    </ViewDialog>
  );
}

// What the chosen file holds, checked against the chosen week, before it is saved.
function UploadPreview({ preview, busy, onSave, onCancel }) {
  const { blogs, errors, warnings, fileName } = preview;
  return (
    <div className="plan-preview">
      <div className="plan-preview-head">
        <b>Check the week before saving</b>
        <span className="muted small">
          {blogs.length} blog{blogs.length === 1 ? '' : 's'} → <span className="mono">{fileName}</span>
          {errors.length ? ` · ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix` : ''}
        </span>
      </div>
      {errors.length > 0 && (
        <ul className="plan-issues error-list">{errors.map((e, i) => <li key={i}>{e.id && <b>{e.id}: </b>}{e.message}</li>)}</ul>
      )}
      {warnings.length > 0 && (
        <ul className="plan-issues warn-list">{warnings.map((w, i) => <li key={i}>{w.id && <b>{w.id}: </b>}{w.message}</li>)}</ul>
      )}
      {blogs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>ID</th><th>Topic</th><th>Category</th></tr></thead>
            <tbody>
              {blogs.map((b) => (
                <tr key={b.n}>
                  <td className="nowrap">{b.publishDate ? fmtDay(b.publishDate) : '—'}</td><td className="mono">{b.id || '—'}</td>
                  <td><div className="ellip wide">{b.topic || '—'}</div></td><td>{b.category || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row plan-actions">
        <button className="btn primary" type="button" disabled={busy || errors.length > 0} onClick={onSave}>
          {busy ? 'Saving…' : 'Save to Supabase Storage'}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        {errors.length > 0 && <span className="muted small">Fix the problems in the file (or pick the right week) and upload it again.</span>}
      </div>
    </div>
  );
}

function WeeklyFilesCard({ admin }) {
  const [weeks] = useState(() => weekChoices()); // fixed while the page is open, so the chosen week can't vanish
  const [week, setWeek] = useState(weeks[1].week); // next week
  const [files, setFiles] = useState({ status: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const [preview, setPreview] = useState(null); // { text, blogs, errors, warnings, week, fileName, label }
  const [confirmDialog, confirm] = useConfirm();
  const [blogView, setBlogView] = useState(null); // { name, n }
  const input = useRef(null);
  const chosen = weeks.find((w) => w.week === week);

  const load = () => listWeeklyFiles()
    .then((items) => setFiles({ status: 'ready', items }))
    .catch(() => setFiles({ status: 'error', items: [] }));
  useEffect(() => { load(); }, []);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again still triggers a check
    if (!file) return;
    setMsg({ text: '', tone: 'error' });
    setPreview(null);
    const text = await file.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      setMsg({ text: `${file.name} is not valid JSON. Check for a missing comma or bracket.`, tone: 'error' });
      return;
    }
    const read = readBlogs(json);
    if (read.error) {
      setMsg({ text: `${file.name}: ${read.error}`, tone: 'error' });
      return;
    }
    setPreview({ text, blogs: read.blogs, ...checkWeek(read.blogs, week), week, fileName: chosen.fileName, label: chosen.label });
  }

  async function onSave() {
    const p = preview;
    setBusy(true);
    try {
      let r;
      try {
        r = await uploadWeeklyFile(p.week, p.text);
      } catch (err) {
        if (err.status !== 409) throw err;
        const ok = await confirm({
          title: `Replace ${p.fileName}?`,
          message: `There is already a file for ${p.label.replace(/ \(.*/, '')}. The new one replaces it.`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!ok) return;
        r = await uploadWeeklyFile(p.week, p.text, true);
      }
      setPreview(null);
      setMsg({ text: `${r.replaced ? 'Replaced' : 'Saved'} ${r.name} in Supabase Storage.`, tone: 'ok' });
      load();
    } catch (err) {
      setMsg({ text: `Couldn't upload: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(name) {
    try {
      const { text } = await getWeeklyFile(name);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000); // some browsers cancel the download if it goes at once
    } catch (err) {
      setMsg({ text: `Couldn't download ${name}: ${err.message}`, tone: 'error' });
    }
  }

  let body;
  if (files.status === 'loading') body = <Skeleton rows={4} />;
  else if (files.status === 'error') body = <ErrorBox what="the weekly blog files" onRetry={load} />;
  else if (!files.items.length) body = <EmptyBox icon="calendar">No weekly blog files yet.{admin ? ' Pick a week and upload its JSON.' : ''}</EmptyBox>;
  else {
    const rows = [];
    for (const f of files.items) {
      rows.push(
        <tr key={`w-${f.name}`} className="week-row">
          <th colSpan={3}>
            <div className="week-file">
              <span>Week of {fmtDay(fileMonday(f.name)).replace(/^\w+, /, '')}</span>
              <span className="mono file-name">{f.name}</span>
              <span className="file-meta">Uploaded {fmtDate(f.updatedAt)}</span>
              <span className="file-buttons">
                <button className="btn small-btn" type="button" onClick={() => onDownload(f.name)}>Download</button>
              </span>
            </div>
          </th>
        </tr>,
      );
      if (f.problem) rows.push(<tr key={`p-${f.name}`}><td colSpan={3} className="muted">Couldn&apos;t read this file: {f.problem}</td></tr>);
      else if (!f.blogs) rows.push(<tr key={`o-${f.name}`}><td colSpan={3} className="muted">Older week: click Download to see it.</td></tr>);
      else if (!f.blogs.length) rows.push(<tr key={`e-${f.name}`}><td colSpan={3} className="muted">No blogs in this file.</td></tr>);
      else {
        for (const b of f.blogs) {
          const open = () => setBlogView({ name: f.name, n: b.n });
          rows.push(
            <tr
              key={`${f.name}-${b.n}`} className="click-row" tabIndex={0} onClick={open}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
            >
              <td className="nowrap">{b.publishDate ? fmtDay(b.publishDate) : <span className="muted">No date</span>}</td>
              <td className="name">
                <div className="ellip wide">{b.topic || b.id || `Blog #${b.n}`}</div>
                {!b.hasContent && <Badge text="No content" tone="amber" />}
              </td>
              <td className="muted">{b.category || '—'}</td>
            </tr>,
          );
        }
      }
    }
    body = (
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Blog</th><th>Category</th></tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="card">
      <CardHead icon="calendar" title="Weekly Blog Files" />
      <p className="muted small card-note">The week&apos;s blogs, saved as one JSON file in Supabase Storage for the publishing agent.</p>
      {admin && (
        <div className="plan-upload">
          <div className="row week-pick">
            <select
              className="select" value={week} disabled={busy} aria-label="Week"
              onChange={(e) => { setWeek(e.target.value); setPreview(null); }}
            >
              {weeks.map((w) => <option key={w.week} value={w.week}>{w.label}</option>)}
            </select>
            <input ref={input} type="file" accept="application/json,.json" hidden onChange={onFile} />
            <button className="btn outline" type="button" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="doc" /> Upload week JSON
            </button>
          </div>
          <div className="muted small">Saved in Supabase Storage as <span className="mono">{chosen.fileName}</span></div>
          {msg.text && <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>}
          {preview && <UploadPreview preview={preview} busy={busy} onSave={onSave} onCancel={() => setPreview(null)} />}
        </div>
      )}
      {body}
      {confirmDialog}
      {blogView && <BlogViewer name={blogView.name} n={blogView.n} onClose={() => setBlogView(null)} />}
    </div>
  );
}

// ---------- Page ----------

export default function BlogsView() {
  const admin = useIsAdmin();
  const list = useList('blogs');
  const { status, data, reload, fetching } = list;
  const ready = status === 'ready';
  const posted = data.posted ?? 0; // across all posts, not just this page
  return (
    <main className="page">
      <div className="page-head"><h1 className="page-title">Blogs</h1><p className="muted">Which blog goes out on which day, from the weekly blog files, and every blog written so far.</p></div>
      <div className="stack-v">
        <WeeklyFilesCard admin={admin} />
        <div className="card">
          <div className="blog-top">
            <div>
              <CardHead icon="doc" title="Blog Tracker" />
              {ready && <div className="total-block"><div className="muted small">Total Blogs</div><div className="big">{data.total}</div></div>}
            </div>
            {ready && (
              <div className="stats">
                <StatBox label="Posted" value={posted} color="var(--green)" />
                <StatBox label="Not Posted" value={data.total - posted} color="var(--amber)" />
              </div>
            )}
          </div>
          <DataTable
            status={status} emptyIcon="doc" emptyText="No blogs yet" what="blogs" onRetry={reload}
            head={<><th>#</th><th>Blog Topic/Title</th><th>Status</th><th>Posted On</th><th className="view">View</th></>}
            busy={fetching} scrollKey={data.page}
            rows={data.items.map((b) => (
              <OpenRow key={b.id} kind="blog" id={b.id}>
                <td className="num">{pad(b.number)}</td><td className="name"><div className="ellip wide">{b.title}</div></td>
                <td><StatusBadge text={b.status} /></td><td><SiteCell site={b.site} /></td><ViewCell />
              </OpenRow>
            ))}
          />
          <Pager list={list} />
        </div>
      </div>
    </main>
  );
}
