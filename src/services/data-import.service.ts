export const CANONICAL_IMPORT_FIELDS = [
  'productCode', 'shortCode', 'name', 'size', 'color', 'price', 'stock', 'category', 'wpLink', 'mediaLink'
] as const;

export type CanonicalImportField = typeof CANONICAL_IMPORT_FIELDS[number];
export type ImportMapping = Partial<Record<CanonicalImportField, string>>;
export type ImportOptions = { defaultSize?: string; priceMultiplier?: number; stockMultiplier?: number };

export type NormalizedImportRow = {
  productCode: string;
  shortCode: string;
  name: string;
  size: string;
  color: string;
  price: number;
  stock: number;
  category: string;
  wpLink: string;
  mediaLink: string;
  sourceRow: number;
};

const FIELD_ALIASES: Record<CanonicalImportField, string[]> = {
  productCode: ['productcode', 'product_code', 'urunkodu', 'urun_kodu', 'stokkodu', 'stok_kodu', 'sku', 'varyantkodu', 'variantcode', 'barcode', 'barkod'],
  shortCode: ['shortcode', 'short_code', 'kisakod', 'kisa_kod', 'modelkodu', 'model_kodu', 'anastokkodu'],
  name: ['name', 'productname', 'product_name', 'urunadi', 'urun_adi', 'urunismi', 'urun_ismi', 'urunbasligi', 'urun_basligi', 'title', 'baslik', 'description', 'aciklama'],
  size: ['size', 'beden', 'numara', 'varyant', 'variant', 'option1', 'olcu'],
  color: ['color', 'colour', 'renk', 'option2'],
  price: ['price', 'satisfiyati', 'satis_fiyati', 'fiyat', 'birimfiyat', 'saleprice', 'sale_price', 'listefiyati'],
  stock: ['stock', 'stok', 'inventory', 'quantity', 'qty', 'adet', 'mevcutadet', 'mevcut_adet', 'stokadedi'],
  category: ['category', 'kategori', 'productcategory', 'urungrubu', 'urun_grubu', 'collection', 'koleksiyon'],
  wpLink: ['wplink', 'wp_link', 'whatsapp', 'producturl', 'product_url', 'urunlinki', 'urun_linki', 'link'],
  mediaLink: ['medialink', 'media_link', 'image', 'imageurl', 'image_url', 'gorsel', 'gorselurl', 'fotograf']
};

function normalizedHeader(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]/g, '');
}

function flattenObject(value: Record<string, unknown>, prefix = '', output: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenObject(child as Record<string, unknown>, path, output);
    else output[path] = Array.isArray(child) ? child.join(', ') : child;
  }
  return output;
}

function findRecordArray(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 6) return [];
  if (Array.isArray(value)) {
    const objects = value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>;
    if (objects.length) return objects.map(item => flattenObject(item));
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  let best: Array<Record<string, unknown>> = [];
  for (const child of Object.values(value as Record<string, unknown>)) {
    const candidate = findRecordArray(child, depth + 1);
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

function detectDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  return candidates.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
}

export function parseCsv(content: string): Array<Record<string, unknown>> {
  const cleaned = String(content || '').replace(/^\uFEFF/, '');
  const firstLine = cleaned.split(/\r?\n/, 1)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char === '"') {
      if (quoted && cleaned[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && cleaned[index + 1] === '\n') index += 1;
      row.push(cell.trim()); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('CSV dosyasında başlık ve en az bir veri satırı bulunmalıdır.');
  const headers = rows[0].map((header, index) => header || `Sütun ${index + 1}`);
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export function parseImportContent(sourceType: string, content: string): Array<Record<string, unknown>> {
  if (sourceType === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error('JSON verisi okunamadı. Geçerli bir JSON dizi veya nesnesi yükleyin.'); }
    const records = findRecordArray(parsed);
    if (!records.length) throw new Error('JSON içinde ürün kayıtlarını içeren bir nesne dizisi bulunamadı.');
    return records;
  }
  return parseCsv(content);
}

export function collectHeaders(records: Array<Record<string, unknown>>): string[] {
  const headers = new Set<string>();
  records.slice(0, 100).forEach(record => Object.keys(record).forEach(key => headers.add(key)));
  return [...headers];
}

export function suggestMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  const normalized = headers.map(header => ({ header, normalized: normalizedHeader(header) }));
  const usedHeaders = new Set<string>();
  for (const field of CANONICAL_IMPORT_FIELDS) {
    const aliases = FIELD_ALIASES[field].map(normalizedHeader);
    const available = normalized.filter(item => !usedHeaders.has(item.header));
    const exact = available.find(item => aliases.includes(item.normalized));
    const partial = available.find(item => item.normalized.length >= 4 && aliases.some(alias => item.normalized.includes(alias) || alias.includes(item.normalized)));
    if (exact || partial) {
      mapping[field] = (exact || partial)!.header;
      usedHeaders.add((exact || partial)!.header);
    }
  }
  return mapping;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  if (!text) return null;
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    text = text.replace(thousands, '').replace(decimal, '.');
  } else if (comma >= 0) text = text.replace(/\./g, '').replace(',', '.');
  else if ((text.match(/\./g) || []).length > 1) text = text.replace(/\./g, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim().toLocaleUpperCase('tr-TR').replace(/\s+/g, '-').replace(/[^A-ZÇĞİÖŞÜ0-9._-]/g, '');
}

function normalizeSize(value: unknown, fallback: string): string {
  const raw = String(value ?? fallback).trim().toUpperCase();
  const aliases: Record<string, string> = { SMALL: 'S', MEDIUM: 'M', LARGE: 'L', 'EXTRA LARGE': 'XL', XLARGE: 'XL' };
  return aliases[raw] || raw || 'STANDART';
}

export function normalizeRecords(records: Array<Record<string, unknown>>, mapping: ImportMapping, options: ImportOptions = {}) {
  const validRows: NormalizedImportRow[] = [];
  const errors: Array<{ row: number; messages: string[] }> = [];
  const warnings: Array<{ row: number; messages: string[] }> = [];
  const seenCodes = new Set<string>();
  const priceMultiplier = Number.isFinite(options.priceMultiplier) && Number(options.priceMultiplier) > 0 ? Number(options.priceMultiplier) : 1;
  const stockMultiplier = Number.isFinite(options.stockMultiplier) && Number(options.stockMultiplier) > 0 ? Number(options.stockMultiplier) : 1;

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const value = (field: CanonicalImportField) => mapping[field] ? record[mapping[field]!] : undefined;
    const messages: string[] = [];
    const rowWarnings: string[] = [];
    const size = normalizeSize(value('size'), options.defaultSize || 'STANDART');
    let productCode = normalizeCode(value('productCode'));
    let shortCode = normalizeCode(value('shortCode'));
    if (!productCode && shortCode) productCode = size === 'STANDART' ? shortCode : `${shortCode}-${size}`;
    if (!shortCode && productCode) shortCode = productCode.includes('-') ? productCode.slice(0, productCode.lastIndexOf('-')) : productCode;
    const name = String(value('name') ?? '').trim();
    const rawPrice = parseNumber(value('price'));
    const rawStock = mapping.stock ? parseNumber(value('stock')) : 0;
    const price = rawPrice === null ? null : Math.round(rawPrice * priceMultiplier * 100) / 100;
    const stock = rawStock === null ? null : Math.floor(rawStock * stockMultiplier);

    if (!productCode) messages.push('Ürün kodu veya kısa kod bulunamadı.');
    if (!name) messages.push('Ürün adı bulunamadı.');
    if (price === null || price < 0 || price > 100_000_000) messages.push('Fiyat geçersiz.');
    if (stock === null || stock < 0 || stock > 10_000_000) messages.push('Stok geçersiz.');
    if (productCode && seenCodes.has(productCode)) messages.push(`Aynı ürün kodu dosyada birden fazla kez kullanılmış: ${productCode}`);
    if (!mapping.stock) rowWarnings.push('Stok sütunu eşleştirilmedi; stok 0 olarak alınacak.');
    if (messages.length) { errors.push({ row: rowNumber, messages }); return; }
    seenCodes.add(productCode);
    if (rowWarnings.length) warnings.push({ row: rowNumber, messages: rowWarnings });
    validRows.push({
      productCode, shortCode, name, size,
      color: String(value('color') ?? 'Standart').trim() || 'Standart',
      price: price!, stock: stock!,
      category: String(value('category') ?? 'Genel').trim() || 'Genel',
      wpLink: String(value('wpLink') ?? '').trim().slice(0, 1000),
      mediaLink: String(value('mediaLink') ?? '').trim().slice(0, 1000),
      sourceRow: rowNumber
    });
  });
  return { validRows, errors, warnings };
}
