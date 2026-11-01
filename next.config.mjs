const contentSecurityPolicy = [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "connect-src 'self' https://wsvjawuikxfzjyivxgsu.supabase.co",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
].join('; ');

/** @type {import('next').NextConfig} */
const config = {
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'tesseract.js', 'tesseract.js-core'],
  // PDF.js loads its worker and native canvas bindings dynamically.
  outputFileTracingIncludes: {
    '/dashboard/**': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/@napi-rs/canvas/**',
      './node_modules/@napi-rs/canvas-*/*',
      // Local OCR for bulk CV intake: WASM core and the bundled Polish model.
      './node_modules/tesseract.js/src/**',
      './node_modules/tesseract.js-core/*.js',
      './node_modules/tesseract.js-core/*.wasm',
      './node_modules/@tesseract.js-data/pol/4.0.0/pol.traineddata.gz',
      './node_modules/@tesseract.js-data/pol/package.json',
    ],
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
    // These headers override those set by route handlers, so routes that carry auth codes, attempt
    // tokens or candidate data keep their stricter policy here (the last matching rule wins).
    ...['/auth/callback', '/api/competency/attempt', '/dashboard/:companyId/recruitments/:recruitmentId/report/export']
      .map(source => ({ source, headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }))];
  },
};
export default config;
