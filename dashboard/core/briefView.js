// The Campaign Agent's research brief, made ready for the proposal page (components/CampaignReviewView.js). Plain JS, so
// it is tested without a browser (core/server/briefView.test.mjs). The brief comes from the agent's review_view.brief:
// { for_sha256, status, company_types, buying_signals, key_terms (each [{ text, sources }]), not_confirmed, queries,
// searched_at }. It names no companies; every statement links to the public pages it comes from.

export const BRIEF_PARTS = [
  ['company_types', 'Typical customers'],
  ['buying_signals', 'Buying signals'],
  ['key_terms', 'Key terms they use'],
];

const STATUS = {
  ready: ['green', 'Ready'],
  partial: ['amber', 'Partly confirmed'],
  unavailable: ['amber', 'Not available'],
};

// "https://www.example.org/a/b" -> "example.org": a short link text; the full address stays in the link.
export function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// What the page shows, or null. Only the brief written for exactly the version on screen: an older one must never sit
// next to a newer proposal. Only http(s) links are kept (a source is shown as a link a person may click).
export function briefFor(brief, candidate) {
  if (!brief || !candidate || !brief.for_sha256 || brief.for_sha256 !== candidate.sha256) return null;
  const [tone, label] = STATUS[brief.status] || ['amber', String(brief.status || 'unknown')];
  const parts = BRIEF_PARTS.map(([key, title]) => ({
    key,
    title,
    items: (brief[key] || [])
      .map((item) => ({
        text: String(item?.text || ''),
        sources: (item?.sources || [])
          .map((url) => ({ url, site: siteOf(url) }))
          .filter((s) => s.site),
      }))
      .filter((item) => item.text),
  })).filter((part) => part.items.length);
  return {
    tone,
    label,
    warn: brief.status === 'unavailable',
    parts,
    notConfirmed: (brief.not_confirmed || []).map(String),
    queries: (brief.queries || []).map(String),
    searchedAt: brief.searched_at || null,
  };
}
