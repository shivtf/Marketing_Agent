import './globals.css';

export const metadata = {
  title: { default: 'Marketing AI Agent', template: '%s · Marketing AI Agent' },
};

// Runs before first paint so the saved (or system) theme applies without a flash.
const THEME_SCRIPT = 'try{var t=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t}catch(e){}';

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* The root layout wraps every page (App Router), so the fonts load everywhere: the rule is for pages/. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
        {/* The app has its own light and dark themes: tells the Dark Reader extension not to repaint it. */}
        <meta name="darkreader-lock" />
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
