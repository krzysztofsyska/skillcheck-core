'use server';

import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { companyAccess } from '../../../../lib/company-access';
import {
  BRAND_ASSET_BUCKET, BRAND_ASSET_LIMITS, brandConfigFromForm, brandObjectPath, brandingEnabled, validateBrandAsset,
  type BrandAssetKind,
} from '../../../../lib/brand-config';
import { brandErrorStatus } from '../../../../lib/brand-server';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (form: FormData, name: string) => { const v = form.get(name); return typeof v === 'string' ? v : ''; };

/** Wspólne sprawdzenie: funkcja włączona, poprawna firma, wywołujący jest
 * właścicielem. Baza sprawdza to samo ponownie (private.brand_require_owner). */
async function ownerContext(form: FormData) {
  const companyId = field(form, 'companyId');
  if (!brandingEnabled() || !uuid.test(companyId)) redirect('/dashboard');
  const access = await companyAccess(companyId);
  const back = (status: string, extra = ''): never => {
    revalidatePath(`/dashboard/${companyId}`, 'layout');
    redirect(`/dashboard/${companyId}/marka?status=${encodeURIComponent(status)}${extra}`);
  };
  if (access.user.id !== access.company.owner_id) back('forbidden');
  return { ...access, companyId, back };
}

export async function saveBrandDraft(form: FormData) {
  const { client, companyId, back } = await ownerContext(form);
  const parsed = brandConfigFromForm(form);
  if (!parsed.ok) back('invalid', `&message=${encodeURIComponent(parsed.error)}`);
  const asset = (name: string) => { const v = field(form, name); return uuid.test(v) ? v : null; };
  const { error } = await client.rpc('brand_save_draft', {
    target_company: companyId, draft_config: parsed.ok ? parsed.value : null, logo: asset('logo'), favicon: asset('favicon'),
  });
  back(error ? brandErrorStatus(error.message) : 'draft_saved');
}

export async function uploadBrandAsset(form: FormData) {
  const { client, companyId, back } = await ownerContext(form);
  const kind = field(form, 'kind') as BrandAssetKind;
  const file = form.get('file');
  if (kind !== 'logo' && kind !== 'favicon') back('asset_invalid');
  if (!(file instanceof File) || file.size === 0) back('asset_invalid', `&message=${encodeURIComponent('Wybierz plik.')}`);
  const upload = file as File;
  if (upload.size > BRAND_ASSET_LIMITS[kind]) {
    back('asset_invalid', `&message=${encodeURIComponent(`Plik jest za duży (limit ${BRAND_ASSET_LIMITS[kind] / 1024} KB).`)}`);
  }
  const bytes = new Uint8Array(await upload.arrayBuffer());
  const checked = validateBrandAsset(bytes, kind);
  if (!checked.ok) back('asset_invalid', `&message=${encodeURIComponent(checked.error)}`);
  if (!checked.ok) return;
  const path = brandObjectPath(companyId, kind, randomUUID(), checked.value.extension);
  const stored = await client.storage.from(BRAND_ASSET_BUCKET).upload(path, bytes, {
    contentType: checked.value.mime, upsert: false, cacheControl: '300',
  });
  if (stored.error) back('asset_invalid');
  const { error } = await client.rpc('brand_register_asset', {
    target_company: companyId, asset_kind: kind, object_path: path, asset_mime: checked.value.mime,
    asset_size: bytes.length, asset_sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  back(error ? brandErrorStatus(error.message) : 'asset_saved');
}

export async function publishBrandDraft(form: FormData) {
  const { client, companyId, back } = await ownerContext(form);
  const draftId = field(form, 'draftId');
  const updatedAt = field(form, 'draftUpdatedAt');
  if (!uuid.test(draftId) || !updatedAt || updatedAt.length > 64) back('draft_changed');
  const { error } = await client.rpc('brand_publish_draft', {
    target_company: companyId, expected_draft: draftId, expected_updated_at: updatedAt,
  });
  back(error ? brandErrorStatus(error.message) : 'published');
}

export async function rollbackBrand(form: FormData) {
  const { client, companyId, back } = await ownerContext(form);
  const versionId = field(form, 'versionId');
  if (!uuid.test(versionId)) back('version_unavailable');
  const { error } = await client.rpc('brand_rollback', { target_company: companyId, target_version: versionId });
  back(error ? brandErrorStatus(error.message) : 'rolled_back');
}
