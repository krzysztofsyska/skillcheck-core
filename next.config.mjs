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
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'tesseract.js', 'tesseract.js-core', '@napi-rs/canvas'],
  // PDF.js loads its worker and native canvas bindings dynamically.
  outputFileTracingIncludes: {
    '/dashboard/**': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/@napi-rs/canvas/**',
      './node_modules/@napi-rs/canvas-*/*',
    ],
    // Local OCR for bulk CV intake, only in the upload route that runs it. Tesseract starts its
    // node worker script by file path, so nft cannot follow it: the worker's own requires are listed
    // here (see node_modules/tesseract.js/src/worker-script; node-fetch is only a fallback when
    // global fetch is missing, never on Node 18+). Node loads <core>.js + <core>.wasm, picked by CPU
    // features; the browser *.wasm.js builds are never used. tesseract.js 7.0.0 getCore() compares a
    // boolean lstmOnly with OEM numbers, so it always takes the non-"-lstm" cores (verified by running
    // OCR from the traced files only); scripts/check-pdf-bundle.mjs asserts exactly these.
    // (Keys are picomatch globs: `[companyId]` would be a character class, so segments are `*`.)
    '/dashboard/*/recruitments/*/bulk/*/items/*': [
      './node_modules/tesseract.js/package.json',
      './node_modules/tesseract.js/src/**/*.js',
      './node_modules/tesseract.js-core/package.json',
      './node_modules/tesseract.js-core/tesseract-core{,-simd,-relaxedsimd}.{js,wasm}',
      './node_modules/wasm-feature-detect/package.json',
      './node_modules/wasm-feature-detect/dist/cjs/index.cjs',
      './node_modules/bmp-js/package.json',
      './node_modules/bmp-js/index.js',
      './node_modules/bmp-js/lib/*.js',
      './node_modules/is-url/package.json',
      './node_modules/is-url/index.js',
      './node_modules/regenerator-runtime/package.json',
      './node_modules/regenerator-runtime/runtime.js',
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
