// The connected Gmail inbox (app/api/gmail), read only. Everyone signed in can read it; only admins connect or
// disconnect. The browser never talks to Google's API: the dashboard's server does.
import { authFetch } from './auth';

const PATH = '/api/gmail';

// -> { configured, connected, email, connectedAt, connectedBy }
export const getGmailStatus = () => authFetch(PATH);

// -> { url } of Google's consent screen; the page sends the browser there. Google sends it back to /history?gmail=...
export const startGmailConnect = () => authFetch(`${PATH}/connect`, { method: 'POST' });

export const disconnectGmail = () => authFetch(PATH, { method: 'DELETE' });

// view: 'inbox' | 'leads'; q: Gmail search text; pageToken: the last page's nextPageToken.
// -> { items, nextPageToken, estimate }
export const listGmail = ({ view, q, pageToken }) => {
  const query = new URLSearchParams(Object.entries({ view, q, pageToken }).filter(([, v]) => v)).toString();
  return authFetch(`${PATH}/messages${query ? `?${query}` : ''}`);
};

// -> the whole email as text: { ..., to, cc, body, attachments, lead }
export const getGmailMessage = (id) => authFetch(`${PATH}/messages/${encodeURIComponent(id)}`);
