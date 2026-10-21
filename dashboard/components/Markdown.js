import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Blog text (markdown) the way it reads once posted: headings, bold, links, code blocks, GitHub tables. Raw HTML in
// the text is shown as text, never run, and unsafe links (javascript:) are dropped (react-markdown's defaults).
// Headings are moved down so the blog's "# Title" fits inside a card (h1 -> h4). Emails keep FormattedContent.
const link = ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />;
const heading = (Tag) => function Heading({ node, ...props }) { return <Tag {...props} />; };

const COMPONENTS = {
  a: link,
  h1: heading('h4'),
  h2: heading('h5'),
  h3: heading('h6'),
  h4: heading('h6'),
  h5: heading('h6'),
  h6: heading('h6'),
  table: ({ node, ...props }) => <div className="md-table"><table {...props} /></div>,
};

export function Markdown({ text }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{text}</ReactMarkdown>;
}
