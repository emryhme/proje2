import crypto from 'crypto';
import { env } from '../config/env';

const PREFIX = 'sv1';

function encryptionKey(): Buffer {
  return crypto.createHash('sha256').update(`${env.jwtSecret}:settings-secret-v1`).digest();
}

export function encryptSettingSecret(value: string): string {
  if (!value || value.startsWith(`${PREFIX}:`)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}:${iv.toString('base64url')}:${encrypted.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptSettingSecret(value: string): string {
  if (!value || !value.startsWith(`${PREFIX}:`)) return value;
  const [prefix, ivText, encryptedText, tagText] = value.split(':');
  if (prefix !== PREFIX || !ivText || !encryptedText || !tagText) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
