import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import crypto from 'crypto';

type RateLimitEntry = { count: number; resetAt: number };

function clientAddress(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}

export function createRateLimiter(options: { windowMs: number; max: number; message: string }) {
  const entries = new Map<string, RateLimitEntry>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = clientAddress(req);
    const current = entries.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;
    entry.count += 1;
    entries.set(key, entry);

    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > options.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      res.status(429).json({ success: false, error: options.message });
      return;
    }

    if (entries.size > 10_000) {
      for (const [entryKey, value] of entries) {
        if (value.resetAt <= now) entries.delete(entryKey);
      }
    }
    next();
  };
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  const suppliedRequestId = String(req.headers['x-request-id'] || '');
  const requestId = /^[A-Za-z0-9._-]{8,80}$/.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://docs.google.com; object-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests");
  if (env.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

export function sanitizeServerErrors(req: Request, res: Response, next: NextFunction): void {
  const sendJson = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 500 && body && Object.prototype.hasOwnProperty.call(body, 'error')) {
      const requestId = String(res.locals.requestId || 'unknown');
      console.error(`[API Error] requestId=${requestId} method=${req.method} path=${req.path} status=${res.statusCode}`);
      return sendJson({ ...body, error: 'İşlem sırasında sunucu hatası oluştu.', requestId });
    }
    return sendJson(body);
  }) as Response['json'];
  next();
}

function cookieValue(req: Request, name: string): string {
  const cookieHeader = String(req.headers.cookie || '');
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

export function sessionCookie(req: Request): string {
  return cookieValue(req, 'iscworks_session');
}

export function setSessionCookie(res: Response, token: string, maxAgeSeconds?: number): void {
  const secure = env.nodeEnv === 'production' ? '; Secure' : '';
  const maxAge = maxAgeSeconds ? `; Max-Age=${Math.floor(maxAgeSeconds)}` : '';
  res.append('Set-Cookie', `iscworks_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Priority=High${maxAge}${secure}`);
}

export function clearSessionCookie(res: Response): void {
  const secure = env.nodeEnv === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `iscworks_session=; Path=/; HttpOnly; SameSite=Strict; Priority=High; Max-Age=0${secure}`);
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !sessionCookie(req)) return next();
  if (req.headers.authorization || req.headers['x-api-key'] || req.headers['x-access-token']) return next();

  const suppliedOrigin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const expectedOrigin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  const sameOrigin = suppliedOrigin === expectedOrigin || (!suppliedOrigin && referer.startsWith(`${expectedOrigin}/`));
  if (!sameOrigin) {
    res.status(403).json({ success: false, error: { code: 'CSRF_REJECTED', message: 'İstek kaynağı doğrulanamadı.' } });
    return;
  }
  next();
}
