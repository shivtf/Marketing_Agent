// Security headers on every page and API route.
// The CSP lists where the page may load from or send to: this site, Supabase, the dashboard backend and Google Fonts.
// A script injected into the page then can't load code from elsewhere or send the login token to another server.
// 'unsafe-inline' scripts are needed by Next.js's own inline scripts and the theme script in app/layout.js.
import nextEnv from '@next/env';

// The CSP below is built when this file is evaluated, which can be before Next has put .env.local into process.env;
// without the Supabase URL the browser is blocked from signing in.
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

const origin = (url) => {
  try { return new URL(url).origin; } catch { return null; }
};
const isDev = process.env.NODE_ENV !== 'production';
const supabase = origin(process.env.NEXT_PUBLIC_SUPABASE_URL);
const backend = origin(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000');

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`, // dev: React's dev tools and hot reload use eval
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  ['connect-src', "'self'", supabase, supabase?.replace(/^http/, 'ws'), backend, isDev && 'ws:'].filter(Boolean).join(' '),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' }, // older browsers; frame-ancestors above does the same
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
