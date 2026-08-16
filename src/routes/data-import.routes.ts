import { NextFunction, Response, Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { db } from '../database/db';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  CANONICAL_IMPORT_FIELDS,
  collectHeaders,
  ImportMapping,
  ImportOptions,
  normalizeRecords,
  parseImportContent,
  suggestMapping
} from '../services/data-import.service';
import { FacebookService } from '../services/facebook.service';

const router = Router();
const MAX_SOURCE_BYTES = 1_800_000;
const MAX_ROWS = 5_000;

function requireInteractiveUser(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.auth?.tokenType === 'api_key' || !req.auth?.userId) {
    res.status(403).json({ success: false, error: 'Önizlemeli veri aktarımı için kullanıcı oturumu gereklidir.' });
    return;
  }
  next();
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateMapping(value: unknown, headers: string[]): ImportMapping {
  const source = safeJsonObject(value);
  const mapping: ImportMapping = {};
  for (const field of CANONICAL_IMPORT_FIELDS) {
    const header = String(source[field] || '').trim();
    if (header && headers.includes(header)) mapping[field] = header;
  }
  return mapping;
}

function validateOptions(value: unknown): ImportOptions {
  const source = safeJsonObject(value);
  const defaultSize = String(source.defaultSize || 'STANDART').trim().slice(0, 30) || 'STANDART';
  const priceMultiplier = Number(source.priceMultiplier || 1);
  const stockMultiplier = Number(source.stockMultiplier || 1);
  return {
    defaultSize,
    priceMultiplier: Number.isFinite(priceMultiplier) && priceMultiplier > 0 && priceMultiplier <= 1000 ? priceMultiplier : 1,
    stockMultiplier: Number.isFinite(stockMultiplier) && stockMultiplier > 0 && stockMultiplier <= 1000 ? stockMultiplier : 1
  };
}

async function resolveSourceContent(body: any): Promise<{ sourceType: string; sourceName: string; content: string }> {
  const requestedType = String(body?.sourceType || 'csv').trim();
  if (requestedType === 'google_sheets') {
    const input = String(body?.sheetUrl || '').trim();
    const match = input.match(/\/d\/([A-Za-z0-9_-]{20,})/) || input.match(/^([A-Za-z0-9_-]{20,})$/);
    if (!match?.[1]) throw new Error('Geçerli bir Google Sheets bağlantısı veya tablo ID’si girin.');
    const sheetId = match[1];
    const response = await axios.get(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq`, {
      params: { tqx: 'out:csv' }, responseType: 'text', timeout: 15_000, maxContentLength: MAX_SOURCE_BYTES
    });
    return { sourceType: 'google_sheets', sourceName: `Google Sheets ${sheetId.slice(0, 8)}…`, content: String(response.data || '') };
  }
  if (!['csv', 'json'].includes(requestedType)) throw new Error('Desteklenmeyen veri kaynağı türü.');
  return {
    sourceType: requestedType,
    sourceName: String(body?.sourceName || '').trim().slice(0, 160),
    content: String(body?.content || '')
  };
}

router.get('/api/data-import/profiles', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  const profiles = db.prepare(`
    SELECT id, name, source_type AS sourceType, mapping_json AS mappingJson, options_json AS optionsJson, updated_at AS updatedAt
    FROM data_mapping_profiles WHERE store_id = ? ORDER BY updated_at DESC
  `).all(req.auth!.storeId) as any[];
  return res.json({
    success: true,
    profiles: profiles.map(profile => ({ ...profile, mapping: JSON.parse(profile.mappingJson), options: JSON.parse(profile.optionsJson), mappingJson: undefined, optionsJson: undefined }))
  });
});

router.get('/api/data-import/history', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  const jobs = db.prepare(`
    SELECT id, source_type AS sourceType, source_name AS sourceName, profile_name AS profileName, status,
           total_rows AS totalRows, valid_rows AS validRows, invalid_rows AS invalidRows,
           inserted_rows AS insertedRows, updated_rows AS updatedRows, created_at AS createdAt, completed_at AS completedAt
    FROM data_import_jobs WHERE store_id = ? ORDER BY id DESC LIMIT 30
  `).all(req.auth!.storeId);
  return res.json({ success: true, jobs });
});

router.post('/api/data-import/analyze', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), requireInteractiveUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { sourceType, sourceName, content } = await resolveSourceContent(req.body || {});
    if (!content.trim()) return res.status(400).json({ success: false, error: 'İçe aktarılacak veri boş.' });
    if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) return res.status(413).json({ success: false, error: 'Veri kaynağı en fazla 1,8 MB olabilir.' });
    const records = parseImportContent(sourceType === 'json' ? 'json' : 'csv', content);
    if (records.length > MAX_ROWS) return res.status(413).json({ success: false, error: `Tek aktarımda en fazla ${MAX_ROWS} kayıt işlenebilir.` });
    const headers = collectHeaders(records);
    const profileId = Number(req.body?.profileId || 0);
    const profile = profileId
      ? db.prepare('SELECT mapping_json, options_json FROM data_mapping_profiles WHERE id = ? AND store_id = ?').get(profileId, req.auth!.storeId) as any
      : null;
    const requestedMapping = req.body?.mapping || (profile ? JSON.parse(profile.mapping_json) : null);
    const requestedOptions = req.body?.options || (profile ? JSON.parse(profile.options_json) : null);
    const mapping = requestedMapping ? validateMapping(requestedMapping, headers) : suggestMapping(headers);
    const options = validateOptions(requestedOptions);
    const result = normalizeRecords(records, mapping, options);
    const previewToken = crypto.randomBytes(32).toString('base64url');
    const preview = db.prepare(`
      INSERT INTO data_import_previews (
        store_id, user_id, token_hash, source_type, source_name, headers_json, mapping_json,
        options_json, valid_rows_json, errors_json, warnings_json, total_rows, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 minutes'))
    `).run(
      req.auth!.storeId, req.auth!.userId, tokenHash(previewToken), sourceType, sourceName,
      JSON.stringify(headers), JSON.stringify(mapping), JSON.stringify(options), JSON.stringify(result.validRows),
      JSON.stringify(result.errors), JSON.stringify(result.warnings), records.length
    );
    return res.json({
      success: true,
      previewId: Number(preview.lastInsertRowid), previewToken, sourceType, sourceName, headers, mapping, options,
      totalRows: records.length, validCount: result.validRows.length, invalidCount: result.errors.length,
      warningCount: result.warnings.length, sampleRows: result.validRows.slice(0, 50),
      errors: result.errors.slice(0, 100), warnings: result.warnings.slice(0, 100)
    });
  } catch (error: any) {
    const externalFailure = error?.isAxiosError;
    return res.status(externalFailure ? 502 : 400).json({ success: false, error: externalFailure ? 'Google Sheets verisi alınamadı. Paylaşım ayarlarını kontrol edin.' : error.message });
  }
});

router.post('/api/data-import/commit', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), requireInteractiveUser, (req: AuthenticatedRequest, res) => {
  try {
    const previewToken = String(req.body?.previewToken || '');
    const profileName = String(req.body?.profileName || '').trim().slice(0, 80);
    const saveProfile = req.body?.saveProfile === true && Boolean(profileName);
    const preview = db.prepare(`
      SELECT * FROM data_import_previews
      WHERE token_hash = ? AND store_id = ? AND user_id = ? AND committed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).get(tokenHash(previewToken), req.auth!.storeId, req.auth!.userId) as any;
    if (!preview) return res.status(404).json({ success: false, error: 'Önizleme bulunamadı, süresi doldu veya daha önce kullanıldı.' });
    const rows = JSON.parse(preview.valid_rows_json) as any[];
    if (!rows.length) return res.status(400).json({ success: false, error: 'İçe aktarılabilecek geçerli kayıt bulunmuyor.' });
    let insertedRows = 0;
    let updatedRows = 0;
    let jobId = 0;
    db.transaction(() => {
      const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(req.auth!.storeId) as any;
      const findProduct = db.prepare('SELECT id FROM products WHERE store_id = ? AND product_code = ?');
      const upsertProduct = db.prepare(`
        INSERT INTO products (store_id, store_name, short_code, product_code, name, color, size, price, stock, category, wp_link, media_link, instagram_media_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(store_id, product_code) DO UPDATE SET
          short_code=excluded.short_code, name=excluded.name, color=excluded.color, size=excluded.size,
          price=excluded.price, stock=excluded.stock, category=excluded.category,
          wp_link=excluded.wp_link, media_link=excluded.media_link, instagram_media_id=excluded.instagram_media_id, updated_at=CURRENT_TIMESTAMP
      `);
      const upsertInventory = db.prepare(`
        INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at)
        VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(store_id, product_code) DO UPDATE SET stock=excluded.stock, updated_at=CURRENT_TIMESTAMP
      `);
      for (const row of rows) {
        const exists = Boolean(findProduct.get(req.auth!.storeId, row.productCode));
        upsertProduct.run(req.auth!.storeId, store?.name || '', row.shortCode, row.productCode, row.name, row.color, row.size, row.price, row.stock, row.category, row.wpLink, row.mediaLink, row.instagramMediaId || '');
        upsertInventory.run(req.auth!.storeId, row.productCode, row.stock);
        if (exists) updatedRows += 1; else insertedRows += 1;
      }
      if (saveProfile) {
        db.prepare(`
          INSERT INTO data_mapping_profiles (store_id, name, source_type, mapping_json, options_json, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(store_id, name) DO UPDATE SET source_type=excluded.source_type, mapping_json=excluded.mapping_json,
            options_json=excluded.options_json, created_by=excluded.created_by, updated_at=CURRENT_TIMESTAMP
        `).run(req.auth!.storeId, profileName, preview.source_type, preview.mapping_json, preview.options_json, req.auth!.userId);
      }
      const job = db.prepare(`
        INSERT INTO data_import_jobs (store_id, user_id, source_type, source_name, profile_name, status, total_rows, valid_rows, invalid_rows, inserted_rows, updated_rows, completed_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(req.auth!.storeId, req.auth!.userId, preview.source_type, preview.source_name, saveProfile ? profileName : '', preview.total_rows, rows.length, JSON.parse(preview.errors_json).length, insertedRows, updatedRows);
      jobId = Number(job.lastInsertRowid);
      db.prepare('UPDATE data_import_previews SET committed_at = CURRENT_TIMESTAMP WHERE id = ?').run(preview.id);
      AuthMiddleware.logAudit(req.auth!.storeId, req.auth!.userId, 'COMMIT_DATA_IMPORT', 'data_import_jobs', String(jobId), '', `${insertedRows} inserted, ${updatedRows} updated`);
    })();
    // A product may arrive after its Instagram post was cached. Reconcile immediately without waiting for the media page.
    FacebookService.reconcileCachedInstagramMedia(req.auth!.storeId);
    return res.json({ success: true, jobId, insertedRows, updatedRows, totalImported: insertedRows + updatedRows, message: `${insertedRows} yeni ürün eklendi, ${updatedRows} ürün güncellendi.` });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'İçe aktarma tamamlanamadı.' });
  }
});

router.delete('/api/data-import/profiles/:id', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  const result = db.prepare('DELETE FROM data_mapping_profiles WHERE id = ? AND store_id = ?').run(Number(req.params.id), req.auth!.storeId);
  return result.changes ? res.json({ success: true }) : res.status(404).json({ success: false, error: 'Eşleştirme profili bulunamadı.' });
});

export default router;
