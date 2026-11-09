export function assessmentCenterPreviewEnabled() {
  return process.env.AC_PAIRED_SHEETS_PREVIEW === 'true'
    && (process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development');
}
