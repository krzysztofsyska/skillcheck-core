// Preview can point at a separate Supabase project, so allow whichever one
// this build is configured for; production falls back to its own project.
const supabaseOrigin = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://wsvjawuikxfzjyivxgsu.supabase.co',
).origin;

const contentSecurityPolicy = [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `connect-src 'self' ${supabaseOrigin}`,
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
].join('; ');

/** @type {import('next').NextConfig} */
const config = {
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist'],
  // PDF.js loads its worker and native canvas bindings dynamically.
  outputFileTracingIncludes: {
    '/dashboard/**': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/@napi-rs/canvas/**',
      './node_modules/@napi-rs/canvas-*/*',
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
