'use client';
// Page 3: Blogs. Weekly Blog Files (the week's JSON, stored as is in Supabase Storage: which blog goes out on which day,
// its approval and its post to Dev.to) on top, and the Blog Tracker (blogs written so far) below.
import { useEffect, useRef, useState } from 'react';
import { OpenRow } from './OpenRow';
import { useList } from './DataProvider';
import { Badge, CardHead, StatusBadge, SiteCell, ViewCell, DataTable, Pager, Skeleton, ErrorBox, EmptyBox, MetaRow, ExtLink } from './ui';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { getSession, isAdmin } from '@/core/auth';
import { pad, fmtDay, fmtDate } from '@/core/format';
import { listWeeklyFiles, getWeeklyFile, uploadWeeklyFile, decideBlogs, removeBlog, weekLabel } from '@/core/blogFiles';
import { postTodaysBlogs, postBlogAgain, getPostingMode } from '@/core/api';
import { readBlogs, checkUpload, findBlog, headline, blogToday, addDays, thisMonday, LATE_DAYS } from '@/core/weeklyBlogs';

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

// ---------- Weekly Blog Files: choose the JSON -> check it -> saved in Supabase Storage -> approve each blog -> post ----------
// The schedule below is read from the stored files themselves (core/weeklyBlogs.js). A blog is posted only once an
// admin approved it here (app/api/blogs/approvals), when an admin clicks "Post today's blogs": the dashboard backend
// posts it to Dev.to (dashboardbackend/app/blog_posts.py) and records it in blog_posts (each blog's `post`).

// India time, like Vercel and the backend (core/weeklyBlogs.js), whatever the browser's clock says.
const todayYmd = () => blogToday();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Posted (or being posted) for real: on Dev.to, public. A Dev.to draft from a test doesn't count.
const isPosted = (post) => !!post && (post.status === 'posting' || (post.status === 'posted' && !post.draft));

// Waiting / Approved / Rejected; once the blog's date has passed: Not approved, or Missed when it was approved but nobody
// posted it on its day (`posted`: it is on Dev.to).
function ApprovalBadge({ approval: a, date, posted }) {
  if (!a) return <span className="muted">—</span>;
  if (a.status === 'approved' && !posted && date && date < todayYmd()) {
    return <Badge text="Missed" tone="red" title={`Approved by ${a.by}, but nobody posted it on its day. It can still be posted for ${LATE_DAYS} days: open it.`} />;
  }
  if (a.status === 'approved') return <Badge text="Approved" tone="green" title={`Approved by ${a.by}, ${fmtDate(a.at)}`} />;
  if (a.status === 'rejected') return <Badge text="Rejected" tone="red" title={a.reason} />;
  if (date && date < todayYmd()) return <Badge text="Not approved" tone="gray" title="Its date has passed: it won't be posted." />;
  return (
    <Badge
      text="Waiting" tone="amber"
      title={a.earlier ? `Changed since it was ${a.earlier.status}: needs a new decision` : "Won't be posted until an admin approves it"}
    />
  );
}

// A blog an admin may take out of its week: it has an id and isn't posted or being posted for real (a Dev.to draft
// aside). The server checks the same. Removing a week's last blog deletes its file.
const removable = (b) => !!b.id && !isPosted(b.post);

// What the backend did with an approved blog: Posted (a link), Posting…, Post failed. null: not posted.
function PostBadge({ post }) {
  if (!post) return null;
  if (post.status === 'posted') {
    const badge = <Badge text={post.draft ? 'Dev.to draft' : 'Posted'} tone={post.draft ? 'blue' : 'green'} title={`Posted ${fmtDate(post.at)}`} />;
    return post.url ? <ExtLink href={post.url}>{badge}</ExtLink> : badge;
  }
  if (post.status === 'failed') return <Badge text="Post failed" tone="red" title={post.error} />;
  return <Badge text="Posting…" tone="amber" title="The backend is posting it to Dev.to" />;
}

// The schedule's Status column: the post once there is one (a Dev.to draft is shown with its approval), else the approval.
const BlogStatus = ({ blog: b }) => (
  b.post && !(b.post.status === 'posted' && b.post.draft)
    ? <PostBadge post={b.post} />
    : <span className="row approval-actions"><ApprovalBadge approval={b.approval} date={b.publishDate} posted={false} /><PostBadge post={b.post} /></span>
);

// Posted, being posted, failed, or missed (approved, never posted, its day passed): what the viewer says about it, and
// (admins) Post again / Post now, from the blog's date up to LATE_DAYS after it (the backend allows the same).
function PostPanel({ admin, name, blog, post, approval, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = todayYmd();
  const date = blog.publishDate;
  const missed = !post && approval?.status === 'approved' && !!date && date < today;
  if (!post && !missed) return null;
  async function again() {
    setBusy(true);
    setError('');
    try {
      const r = await postBlogAgain(name, blog.id);
      if (r.failed.length) setError(r.failed[0].error);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const lastDay = date ? addDays(date, LATE_DAYS) : '';
  const inTime = !!date && date <= today && today <= lastDay;
  let text;
  if (missed) {
    text = inTime
      ? <>Approved, but nobody posted it on {fmtDay(date, 'long')}. It can still be posted until {fmtDay(lastDay, 'long')}.</>
      : <>Approved, but nobody posted it on {fmtDay(date, 'long')}, and it is too late now: it won&apos;t be posted.</>;
  } else if (post.status === 'posted') {
    text = <>{post.draft ? 'Saved as a Dev.to draft (test mode)' : 'Posted to Dev.to'} {fmtDate(post.at)}.{' '}
      {post.url && <ExtLink href={post.url}>Open it</ExtLink>}</>;
  } else if (post.status === 'failed') {
    text = <>Posting to Dev.to failed: <i>{post.error}</i>{!inTime && ' It is too late to post it again.'}</>;
  } else {
    text = <>Being posted to Dev.to now. If this stays for more than 15 minutes, Post again.</>;
  }
  const canPost = admin && inTime && (missed || post.status !== 'posted');
  return (
    <div className="approval-box">
      <div className="approval-head"><b>Dev.to</b>{post ? <PostBadge post={post} /> : <Badge text="Missed" tone="red" />}</div>
      <p className="small">{text}</p>
      {canPost && (
        <div className="row approval-actions">
          <button className="btn small-btn" type="button" disabled={busy} onClick={again}>
            {busy ? 'Posting…' : missed ? 'Post now' : 'Post again'}
          </button>
          {post?.status === 'failed' && <span className="muted small">Post again looks on Dev.to first, so a blog that got there anyway is not posted twice.</span>}
        </div>
      )}
      {error && <div className="auth-msg" role="alert" data-tone="error">{error}</div>}
    </div>
  );
}

// The approval of the blog open in the viewer, and (admins) Approve / Reject / Move back to waiting. `entry` is
// { hash, approval } from the file as just read: the decision is for that version (409 if the file changed since).
function ApprovalPanel({ admin, name, blog, entry, problem, onDone }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (problem) return <div className="approval-box"><div className="muted small">{problem}</div></div>;
  if (!blog.id || !entry) {
    return <div className="approval-box"><div className="muted small">This blog has no id, so it can&apos;t be approved: add one in the file.</div></div>;
  }
  const a = entry.approval || { status: 'waiting' };
  const past = !!blog.publishDate && blog.publishDate < todayYmd();
  // Posted or being posted for real: the decision can't change any more (the server refuses it too).
  const locked = isPosted(entry.post);
  const empty = !blog.content.trim(); // can't be posted, so can't be approved (the server refuses it too)

  async function send(status, why = '') {
    setBusy(true);
    setError('');
    try {
      await decideBlogs(name, [{ id: blog.id, status, reason: why, hash: entry.hash }]);
      setRejecting(false);
      setReason('');
      onDone();
    } catch (err) {
      setError(err.message);
      if (err.status === 409) onDone(); // the file changed: show the blog as it is now
    } finally {
      setBusy(false);
    }
  }

  let text;
  if (a.status === 'approved') {
    text = locked
      ? <>Approved by {a.by}, {fmtDate(a.at)}.</>
      : past
        ? <>Approved by {a.by}, {fmtDate(a.at)}.</>
        : <>Approved by {a.by}, {fmtDate(a.at)}. This version goes to Dev.to when an admin clicks Post today&apos;s blogs on {fmtDay(blog.publishDate, 'long')}: nothing posts it on its own.</>;
  } else if (a.status === 'rejected') {
    text = <>Rejected by {a.by}, {fmtDate(a.at)}: <i>{a.reason}</i> It won&apos;t be posted.</>;
  } else if (past) {
    text = <>Not approved, and its date has passed: it won&apos;t be posted.</>;
  } else {
    text = <>Waiting for approval: it won&apos;t be posted until an admin approves it.
      {a.earlier && ` It was ${a.earlier.status} before, but the file was replaced and this blog changed.`}</>;
  }
  return (
    <div className="approval-box">
      <div className="approval-head"><b>Approval</b><ApprovalBadge approval={a} date={blog.publishDate} posted={locked} /></div>
      <p className="small">{text}</p>
      {admin && empty && a.status !== 'approved' && !past && <p className="small muted">It has no content, so it can&apos;t be approved: fix the file and upload it again.</p>}
      {admin && !rejecting && !locked && (
        <div className="row approval-actions">
          {a.status !== 'approved' && !past && !empty && (
            <button className="btn primary small-btn" type="button" disabled={busy} onClick={() => send('approved')}>
              <Icon name="check" /> Approve
            </button>
          )}
          {a.status !== 'rejected' && (
            <button className="btn small-btn" type="button" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>
          )}
          {a.status !== 'waiting' && (
            <button className="btn small-btn" type="button" disabled={busy} onClick={() => send('waiting')}>Move back to waiting</button>
          )}
        </div>
      )}
      {admin && rejecting && (
        <form className="approval-reject" onSubmit={(e) => { e.preventDefault(); send('rejected', reason); }}>
          <textarea
            rows={2} value={reason} maxLength={1000} autoFocus aria-label="Why it is rejected"
            placeholder="Why is it rejected? (the team sees this)" onChange={(e) => setReason(e.target.value)}
          />
          <div className="row approval-actions">
            <button className="btn danger-fill small-btn" type="submit" disabled={busy || !reason.trim()}>Reject</button>
            <button className="btn small-btn" type="button" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <div className="auth-msg" role="alert" data-tone="error">{error}</div>}
    </div>
  );
}

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

// One blog from a stored file: its details, its approval and its text. `row` is the schedule row clicked; the file is
// read again, so if it was replaced since the page loaded the blog is found by its id and the schedule is refreshed
// (onStale, also called after a decision).
function BlogViewer({ name, row, admin, onClose, onStale }) {
  const [state, setState] = useState({ status: 'loading' });
  const [version, setVersion] = useState(0); // + 1 after a decision: read the file and its approvals again
  const stale = useRef(onStale);
  stale.current = onStale;
  useEffect(() => {
    getWeeklyFile(name)
      .then(({ text, approvals, approvalProblem }) => {
        const found = findBlog(readBlogs(JSON.parse(text)).blogs || [], row);
        if (!found || found.changed) stale.current();
        setState(found
          ? { status: 'ready', ...found, entry: found.blog.id ? approvals?.[found.blog.id] : null, approvalProblem }
          : { status: 'error', message: `This blog is no longer in ${name}: the file was replaced. The schedule has been refreshed.` });
      })
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, [name, row, version]);
  const decided = () => { setVersion((v) => v + 1); stale.current(); };
  const b = state.blog;
  const join = (xs) => (xs?.length ? xs.join(', ') : '—');
  return (
    <ViewDialog title={b ? headline(b) || b.id : 'Blog'} onClose={onClose}>
      {state.status === 'loading' && <Skeleton rows={6} />}
      {state.status === 'error' && <div className="notice">{state.message}</div>}
      {state.changed && (
        <div className="notice">{name} was replaced since the page loaded: this is the blog as it is now. The schedule has been refreshed.</div>
      )}
      {b && (
        <div className="file-view-body blog-view">
          <PostPanel admin={admin} name={name} blog={b} post={state.entry?.post} approval={state.entry?.approval} onDone={decided} />
          <ApprovalPanel
            key={`${b.id}-${state.entry?.hash}`} admin={admin} name={name} blog={b} entry={state.entry}
            problem={state.approvalProblem} onDone={decided}
          />
          <div className="meta">
            <MetaRow k="ID"><span className="mono">{b.id || '—'}</span></MetaRow>
            {b.title && b.topic && <MetaRow k="Topic">{b.topic}</MetaRow>}
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
            ? <div className="content"><Markdown text={b.content} /></div>
            : <div className="muted">No content in the file.</div>}
        </div>
      )}
    </ViewDialog>
  );
}

// What the chosen file holds and which week its dates are in, checked, before it is saved.
function UploadPreview({ preview, busy, onSave, onCancel }) {
  const { blogs, errors, warnings, fileName } = preview;
  return (
    <div className="plan-preview">
      <div className="plan-preview-head">
        <b>{fileName ? <>This file is for {weekLabel(fileName)}</> : 'The week is unknown: no blog has a real date'}</b>
        <span className="muted small">
          {blogs.length} blog{blogs.length === 1 ? '' : 's'}{fileName && <> → <span className="mono">{fileName}</span></>}
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
            <thead><tr><th>Date</th><th>ID</th><th>Title</th><th>Category</th></tr></thead>
            <tbody>
              {blogs.map((b) => (
                <tr key={b.n}>
                  <td className="nowrap">{b.publishDate ? fmtDay(b.publishDate) : '—'}</td><td className="mono">{b.id || '—'}</td>
                  <td><div className="ellip wide">{headline(b) || '—'}</div></td><td>{b.category || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row plan-actions">
        <button className="btn primary" type="button" disabled={busy || errors.length > 0 || !fileName} onClick={onSave}>
          {busy ? 'Saving…' : 'Save to Supabase Storage'}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        {errors.length > 0
          ? <span className="muted small">Fix the problems in the file and upload it again.</span>
          : <span className="muted small">Saved blogs wait for approval: nothing is posted until an admin approves it and posts it.</span>}
      </div>
    </div>
  );
}

function WeeklyFilesCard({ admin, onTrackerChange }) {
  const [files, setFiles] = useState({ status: 'loading', items: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', tone: 'error' });
  const [preview, setPreview] = useState(null); // { text, blogs, errors, warnings, monday, fileName }
  const [confirmDialog, confirm] = useConfirm();
  const [blogView, setBlogView] = useState(null); // { name, row }: the file and the schedule row clicked
  // Blogs removed while the page is open ("file\nid"): hidden at once, and kept hidden even if a reload still gets the
  // old copy of the file for a moment.
  const [removed, setRemoved] = useState(() => new Set());
  const input = useRef(null);
  // What Post today's blogs does on the backend: off (no button), draft (test: Dev.to drafts) or live. null: unknown.
  const [mode, setMode] = useState(null);
  useEffect(() => {
    if (admin) getPostingMode().then((r) => setMode(r.mode)).catch(() => setMode(null));
  }, [admin]);

  const load = () => listWeeklyFiles()
    .then((items) => setFiles({ status: 'ready', items }))
    .catch(() => setFiles({ status: 'error', items: [] }));
  useEffect(() => { load(); }, []);
  // The "Saved"/"Replaced" note hides itself after 5 seconds; errors stay until the next upload.
  useEffect(() => {
    if (msg.tone !== 'ok' || !msg.text) return undefined;
    const t = setTimeout(() => setMsg({ text: '', tone: 'error' }), 5000);
    return () => clearTimeout(t);
  }, [msg]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again still triggers a check
    if (!file) return;
    setMsg({ text: '', tone: 'error' });
    setPreview(null);
    const text = await file.text();
    const check = checkUpload(text); // the week comes from its dates; the server runs it again before saving
    if (check.error) {
      setMsg({ text: `${file.name}: ${check.error}`, tone: 'error' });
      return;
    }
    setPreview({ text, ...check });
  }

  async function onSave() {
    const p = preview;
    setBusy(true);
    try {
      let r;
      try {
        r = await uploadWeeklyFile(p.text);
      } catch (err) {
        if (err.status !== 409) throw err;
        const ok = await confirm({
          title: `Replace ${p.fileName}?`,
          message: `There is already a file for ${weekLabel(p.fileName)}. The new one replaces it.`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!ok) return;
        r = await uploadWeeklyFile(p.text, true);
      }
      setPreview(null);
      const again = r.unapproved?.length
        ? ` ${plural(r.unapproved.length, 'approved blog')} changed and wait${r.unapproved.length === 1 ? 's' : ''} for approval again.`
        : '';
      setMsg({ text: `${r.replaced ? 'Replaced' : 'Saved'} ${r.name} in Supabase Storage.${again}`, tone: 'ok' });
      load();
    } catch (err) {
      setMsg({ text: `Couldn't upload: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // Approve every waiting blog of one week whose date hasn't passed, each as listed (its hash).
  async function approveWeek(f, list) {
    const ok = await confirm({
      title: `Approve ${plural(list.length, 'blog')}?`,
      message: `${weekLabel(f.name)}: ${list.length === 1 ? 'it goes' : 'they go'} to Dev.to exactly as ${list.length === 1 ? 'it is' : 'they are'} now, when an admin clicks Post today's blogs on ${list.length === 1 ? 'its day' : 'each day'}. Open a blog to read it first.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await decideBlogs(f.name, list.map((b) => ({ id: b.id, status: 'approved', hash: b.hash })));
      setMsg({ text: `Approved ${plural(list.length, 'blog')} of ${weekLabel(f.name)}.`, tone: 'ok' });
    } catch (err) {
      setMsg({ text: `Couldn't approve: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
      load();
    }
  }

  // Take one blog out of its week (and its approval), so it is never posted and leaves this page. `b.hash` is the
  // version listed: if the file was replaced since, the server refuses and the list is read again.
  async function removeRow(f, b, last) {
    // A week not over yet can be uploaded again (its Monday is in the name, DD_MM_YY).
    const monday = `20${f.name.slice(6, 8)}-${f.name.slice(3, 5)}-${f.name.slice(0, 2)}`;
    const back = monday >= thisMonday()
      ? 'To bring it back, upload the week\'s file again with it.'
      : 'It can\'t be brought back: its week is over.';
    const ok = await confirm({
      title: `Remove ${b.id}?`,
      message: last
        ? `"${headline(b) || b.id}" is the last blog of ${weekLabel(f.name)}, so the week's file ${f.name} is deleted. It won't be posted. ${back}`
        : `"${headline(b) || b.id}" is taken out of ${f.name} and won't be posted. ${back}`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const k = `${f.name}\n${b.id}`;
    const show = (on) => setRemoved((prev) => { const next = new Set(prev); if (on) next.delete(k); else next.add(k); return next; });
    show(false); // gone from the list at once; back if the server refuses
    setBusy(true); // one change to the files at a time: two saves of the same file would undo each other
    try {
      const r = await removeBlog(f.name, b.id, b.hash);
      setMsg({ text: `Removed ${b.id} from ${weekLabel(f.name)}${r.fileDeleted ? `, and the week's file with it` : ''}. It won't be posted.`, tone: 'ok' });
      if (b.post) onTrackerChange(); // its test draft or failed attempt leaves the Blog Tracker too
    } catch (err) {
      show(true);
      setMsg({ text: `Couldn't remove ${b.id}: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
      load();
    }
  }

  // Post every blog approved for today that isn't posted yet (dashboard backend -> Dev.to).
  async function postToday(count) {
    const ok = await confirm({
      title: `Post ${plural(count, 'blog')} to Dev.to?`,
      message: `Today's approved ${count === 1 ? 'blog goes' : 'blogs go'} out now, exactly as approved. A posted blog can't be taken back from here.`,
      confirmLabel: 'Post',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await postTodaysBlogs();
      const draft = r.mode === 'draft' ? ' as Dev.to drafts (test mode)' : ' to Dev.to';
      const parts = [];
      if (r.posted.length) parts.push(`Posted ${plural(r.posted.length, 'blog')}${draft}.`);
      if (r.failed.length) parts.push(`${plural(r.failed.length, 'blog')} failed: ${r.failed.map((f) => `${f.blogId}: ${f.error}`).join(' ')}`);
      if (!parts.length) parts.push('Nothing to post: today\'s approved blogs are already posted.');
      setMsg({ text: parts.join(' '), tone: r.failed.length ? 'error' : 'ok' });
    } catch (err) {
      setMsg({ text: `Couldn't post: ${err.message}`, tone: 'error' });
    } finally {
      setBusy(false);
      load();
      onTrackerChange(); // new posts show in the Blog Tracker
    }
  }

  // Today's approved blogs the backend hasn't posted yet. A Dev.to draft is done in test mode, but still to post once
  // posting is live (a click then posts it for real). Nothing is due while posting is off.
  const today = todayYmd();
  const dueToday = mode === 'off' ? 0 : files.items.flatMap((f) => f.blogs || []).filter((b) => b.id && b.publishDate === today
    && b.approval?.status === 'approved' && (!b.post || (mode === 'live' && b.post.status === 'posted' && b.post.draft))).length;

  let body;
  if (files.status === 'loading') body = <Skeleton rows={4} />;
  else if (files.status === 'error') body = <ErrorBox what="the weekly blog files" onRetry={load} />;
  else if (!files.items.length) body = <EmptyBox icon="calendar">No weekly blog files yet.{admin ? " Upload a week's JSON." : ''}</EmptyBox>;
  else {
    const rows = [];
    const cols = admin ? 5 : 4;
    for (const f of files.items) {
      if (f.problem) rows.push(<tr key={`p-${f.name}`}><td colSpan={cols} className="muted">Couldn&apos;t read {f.name}: {f.problem}</td></tr>);
      else if (!f.blogs) continue; // older weeks: not read for the schedule
      else {
        const listed = f.blogs.filter((b) => !removed.has(`${f.name}\n${b.id}`));
        if (!listed.length) continue; // its last blog was just removed: the file is gone
        const waiting = listed.filter((b) => b.approval?.status === 'waiting' && b.publishDate >= today);
        const approvable = admin ? waiting.filter((b) => b.id && b.hasContent) : []; // an empty blog can't be approved
        rows.push(
          <tr key={`w-${f.name}`} className="week-row">
            <td colSpan={cols}>
              <div className="week-row-inner">
                <span>
                  <b>{weekLabel(f.name)}</b>
                  <span className="muted small"> · {plural(listed.length, 'blog')}{waiting.length ? ` · ${waiting.length} waiting for approval` : ''}</span>
                </span>
                {approvable.length > 0 && (
                  <button className="btn small-btn" type="button" disabled={busy} onClick={() => approveWeek(f, approvable)}>
                    <Icon name="check" /> Approve all waiting ({approvable.length})
                  </button>
                )}
              </div>
            </td>
          </tr>,
        );
        for (const b of listed) {
          const open = () => setBlogView({ name: f.name, row: b });
          rows.push(
            <tr
              key={`${f.name}-${b.n}`} className="click-row" tabIndex={0} onClick={open}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
            >
              <td className="nowrap">{b.publishDate ? fmtDay(b.publishDate) : <span className="muted">No date</span>}</td>
              <td className="name">
                <div className="ellip wide">{headline(b) || b.id || `Blog #${b.n}`}</div>
                {!b.hasContent && <Badge text="No content" tone="amber" />}
              </td>
              <td className="muted">{b.category || '—'}</td>
              <td><BlogStatus blog={b} /></td>
              {admin && (
                <td className="row-action">
                  {removable(b) && (
                    <button
                      className="icon-btn" type="button" disabled={busy} title="Remove from this week"
                      aria-label={`Remove ${b.id} from this week`}
                      onClick={(e) => { e.stopPropagation(); removeRow(f, b, listed.length === 1); }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                </td>
              )}
            </tr>,
          );
        }
      }
    }
    const approvalProblem = files.items.find((f) => f.approvalProblem)?.approvalProblem;
    body = !rows.length ? <EmptyBox icon="calendar">No blogs in the recent weekly files.</EmptyBox> : (
      <>
        {approvalProblem && <div className="notice">{approvalProblem}</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Blog</th><th>Category</th><th>Status</th>{admin && <th aria-label="Remove" />}</tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div className="card">
      <CardHead icon="calendar" title="Weekly Blog Files" />
      <p className="muted small card-note">The week&apos;s blogs, saved as one JSON file in Supabase Storage. A blog goes to Dev.to only after an admin approves it here, when an admin clicks Post today&apos;s blogs on its day.</p>
      {admin && (
        <div className="plan-upload">
          <div className="row week-pick">
            <span className="muted small">The week (Monday to Saturday) is read from the blogs&apos; dates. This week or a later one.</span>
            <input ref={input} type="file" accept="application/json,.json" hidden onChange={onFile} />
            <button className="btn outline" type="button" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="doc" /> Upload week JSON
            </button>
          </div>
          {msg.text && <div className="auth-msg" role="alert" aria-live="polite" data-tone={msg.tone}>{msg.text}</div>}
          {preview && <UploadPreview preview={preview} busy={busy} onSave={onSave} onCancel={() => setPreview(null)} />}
        </div>
      )}
      {admin && mode === 'draft' && (
        <div className="notice small" title="Blogs are sent to Dev.to as unpublished drafts (BLOG_POSTING=draft on the backend).">Test mode</div>
      )}
      {admin && dueToday > 0 && (
        <div className="row post-today">
          <span className="small"><b>{plural(dueToday, 'approved blog')}</b> for today not posted yet{mode === 'draft' ? ' (test mode: as drafts)' : ''}.</span>
          <button className="btn primary small-btn" type="button" disabled={busy} onClick={() => postToday(dueToday)}>
            <Icon name="check" /> Post today&apos;s blogs
          </button>
        </div>
      )}
      {body}
      {confirmDialog}
      {blogView && <BlogViewer name={blogView.name} row={blogView.row} admin={admin} onClose={() => setBlogView(null)} onStale={load} />}
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
        <WeeklyFilesCard admin={admin} onTrackerChange={reload} />
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
