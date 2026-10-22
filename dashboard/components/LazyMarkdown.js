'use client';
// Markdown (components/Markdown.js), loaded only when a blog's text is first shown: react-markdown and remark-gfm are
// large, and the drawer that uses them is on every page. Emails don't need them (FormattedContent).
import dynamic from 'next/dynamic';
import { Skeleton } from './ui';

export const Markdown = dynamic(() => import('./Markdown').then((m) => m.Markdown), {
  loading: () => <Skeleton rows={4} />,
});
