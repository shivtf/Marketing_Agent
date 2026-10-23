import './globals.css';
import { Inter, JetBrains_Mono } from 'next/font/google';

// Self-hosted at build time: no render-blocking request to Google, no layout shift.
const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], display: 'swap', variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], display: 'swap', variable: '--font-mono' });

export const metadata = {
  title: { default: 'Marketing AI Agent', template: '%s · Marketing AI Agent' },
};

// Runs before first paint so the saved (or system) theme applies without a flash.
const THEME_SCRIPT = 'try{var t=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t}catch(e){}';

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <head>
        {/* The app has its own light and dark themes: tells the Dark Reader extension not to repaint it. */}
        <meta name="darkreader-lock" />
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
