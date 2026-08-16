import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { db } from '../database/db';
import { sessionCookie } from './security.middleware';

export interface AuthContext {
  userId: number;
  storeId: number;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'STAFF';
  email: string;
  storeSlug?: string;
  tokenType?: 'jwt' | 'api_key';
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Production-Grade HMAC-SHA256 JWT, RBAC & Tenant Isolation Middleware
 */
export class AuthMiddleware {
  /**
   * Generates signed JWT Token
   */
  public static generateToken(payload: { userId: number; storeId: number; role: string; email: string; sessionVersion?: number }): string {
    const secret = env.jwtSecret;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      ...payload,
      sessionVersion: Number(payload.sessionVersion || 0),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (3600 * env.sessionTtlHours)
    })).toString('base64url');

    const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  /**
   * Verifies JWT Token Signature and Claims
   */
  public static verifyToken(token: string): { userId: number; storeId: number; role: string; email: string; sessionVersion: number } | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const secret = env.jwtSecret;
    const expectedSig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

    const suppliedSignature = Buffer.from(signature, 'base64url');
    const expectedSignature = Buffer.from(expectedSig, 'base64url');
    if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) return null;

    try {
      const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      if (parsedHeader?.alg !== 'HS256' || parsedHeader?.typ !== 'JWT') return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= now || payload.iat > now + 60) return null;
      if (!payload.userId || !payload.storeId) return null;
      return {
        userId: Number(payload.userId),
        storeId: Number(payload.storeId),
        role: payload.role || 'STAFF',
        email: payload.email || '',
        sessionVersion: Number(payload.sessionVersion || 0)
      };
    } catch {
      return null;
    }
  }

  /**
   * Authentication & Authorization Middleware - Enforces DB Membership Verification
   */
  public static authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    let token = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-access-token']) {
      token = String(req.headers['x-access-token']).trim();
    } else {
      token = sessionCookie(req);
    }

    // API Key Authentication Support
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey) {
      const keyHash = crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
      const apiKeyRecord = db.prepare(`
        SELECT k.id, k.store_id, k.name, k.permissions, k.expires_at, k.revoked_at, s.status as store_status
        FROM api_keys k
        JOIN stores s ON s.id = k.store_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
          AND s.status = 'active'
      `).get(keyHash) as any;

      if (!apiKeyRecord) {
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Geçersiz veya pasif API key.' } });
        return;
      }

      const permission = String(apiKeyRecord.permissions || 'read_write');
      const isWriteRequest = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const isAllowed = permission === 'read_write' || (!isWriteRequest && permission === 'read') || (isWriteRequest && permission === 'write');
      if (!isAllowed) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'API key bu işlem kapsamına sahip değil.' } });
        return;
      }

      db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(apiKeyRecord.id);

      req.auth = {
        userId: 0,
        storeId: apiKeyRecord.store_id,
        role: permission === 'read' ? 'STAFF' : 'MANAGER',
        email: `api_key:${apiKeyRecord.name}`,
        tokenType: 'api_key'
      };
      return next();
    }

    if (!token) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulama tokenı eksik.' }
      });
      return;
    }

    const authPayload = AuthMiddleware.verifyToken(token);
    if (!authPayload) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Geçersiz veya süresi dolmuş kimlik doğrulama tokenı.' }
      });
      return;
    }

    // Database verification: Validate active Membership & active Store
    const membershipRecord = db.prepare(`
      SELECT m.role, m.status as membership_status, s.status as store_status, s.slug as store_slug,
             u.status as user_status, u.session_version, u.email as user_email, ss.ends_at as plan_ends_at
      FROM memberships m
      JOIN stores s ON s.id = m.store_id
      JOIN users u ON u.id = m.user_id
      LEFT JOIN store_subscriptions ss ON ss.store_id = s.id
      WHERE m.user_id = ? AND m.store_id = ?
    `).get(authPayload.userId, authPayload.storeId) as any;

    if (!membershipRecord) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Bu mağazaya erişim üyeliğiniz bulunmamaktadır.' }
      });
      return;
    }

    if (membershipRecord.user_status !== 'active' || membershipRecord.membership_status !== 'active' || membershipRecord.store_status !== 'active') {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Mağaza üyeliğiniz veya mağaza pasif durumdadır.' }
      });
      return;
    }
    if (Number(membershipRecord.session_version || 0) !== authPayload.sessionVersion) {
      res.status(401).json({ success: false, error: { code: 'SESSION_REVOKED', message: 'Oturumunuz sonlandırılmış. Lütfen yeniden giriş yapın.' } });
      return;
    }

    const planExpired = authPayload.storeId !== 1
      && membershipRecord.plan_ends_at
      && String(membershipRecord.plan_ends_at).slice(0, 10) < new Date().toISOString().slice(0, 10);
    const expiredPlanAllowed = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      || (req.method === 'POST' && req.path === '/api/plan/support-requests');
    if (planExpired && !expiredPlanAllowed) {
      res.status(402).json({
        success: false,
        error: { code: 'PLAN_EXPIRED', message: 'Plan süreniz dolduğu için panel salt okunur durumda. Plan Yönetimi bölümünden destek talebi açabilirsiniz.' }
      });
      return;
    }

    req.auth = {
      userId: authPayload.userId,
      storeId: authPayload.storeId,
      role: (membershipRecord.role || authPayload.role) as any,
      email: membershipRecord.user_email,
      storeSlug: membershipRecord.store_slug,
      tokenType: 'jwt'
    };
    next();
  }

  /**
   * Master Admin Middleware - Enforces Master Admin (Store ID 1 & OWNER role)
   */
  public static requireMasterAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!req.auth) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Yetkisiz erişim.' } });
      return;
    }

    if (req.auth.storeId === 1 && req.auth.role === 'OWNER') {
      return next();
    }

    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Bu işlem için Master Admin (Platform Yöneticisi) yetkisi gereklidir.' }
    });
  }

  /**
   * RBAC Middleware - Enforces Required Role Matrix
   */
  public static requireRole(allowedRoles: string[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.auth) {
        res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Yetkisiz erişim.' } });
        return;
      }

      if (req.auth.role === 'OWNER' || allowedRoles.includes(req.auth.role)) {
        return next();
      }

      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Bu işlem için gerekli role yetkiniz bulunmamaktadır.' }
      });
    };
  }

  /**
   * Audit Logging Helper Method
   */
  public static logAudit(storeId: number, userId: number, action: string, entityType: string, entityId: string = '', oldValue: string = '', newValue: string = ''): void {
    try {
      db.prepare(`
        INSERT INTO audit_logs (store_id, user_id, action, entity_type, entity_id, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(storeId, userId, action, entityType, entityId, oldValue, newValue);
    } catch (e: any) {
      console.warn('[Audit Log Warning]:', e.message);
    }
  }

  /**
   * Production CORS Whitelist Middleware
   */
  public static cors(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    const allowedOrigins = env.corsOrigins === '*' ? '*' : env.corsOrigins.split(',').map(value => value.trim()).filter(Boolean);

    if (allowedOrigins === '*' || (origin && allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token, X-Api-Key');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  }
}
