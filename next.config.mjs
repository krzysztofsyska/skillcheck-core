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
};
export default config;
