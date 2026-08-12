"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthMiddleware = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const db_1 = require("../database/db");
/**
 * Production-Grade HMAC-SHA256 JWT, RBAC & Tenant Isolation Middleware
 */
class AuthMiddleware {
    /**
     * Generates signed JWT Token
     */
    static generateToken(payload) {
        const secret = env_1.env.jwtSecret;
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const body = Buffer.from(JSON.stringify({
            ...payload,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + (86400 * 30) // 30 Days
        })).toString('base64url');
        const signature = crypto_1.default.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
        return `${header}.${body}.${signature}`;
    }
    /**
     * Verifies JWT Token Signature and Claims
     */
    static verifyToken(token) {
        if (!token)
            return null;
        const parts = token.split('.');
        if (parts.length !== 3)
            return null;
        const [header, body, signature] = parts;
        const secret = env_1.env.jwtSecret;
        const expectedSig = crypto_1.default.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
        if (signature !== expectedSig)
            return null;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
                return null; // Expired
            }
            if (!payload.userId || !payload.storeId)
                return null;
            return {
                userId: Number(payload.userId),
                storeId: Number(payload.storeId),
                role: payload.role || 'STAFF',
                email: payload.email || ''
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Authentication & Authorization Middleware - Enforces DB Membership Verification
     */
    static authenticate(req, res, next) {
        const authHeader = req.headers.authorization;
        let token = '';
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7).trim();
        }
        else if (req.headers['x-access-token']) {
            token = String(req.headers['x-access-token']).trim();
        }
        // API Key Authentication Support
        const apiKey = req.headers['x-api-key'];
        if (apiKey) {
            const keyHash = crypto_1.default.createHash('sha256').update(apiKey.trim()).digest('hex');
            const apiKeyRecord = db_1.db.prepare(`
        SELECT k.id, k.store_id, k.name, k.permissions, k.expires_at, k.revoked_at, s.status as store_status
        FROM api_keys k
        JOIN stores s ON s.id = k.store_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
          AND s.status = 'active'
      `).get(keyHash);
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
            db_1.db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(apiKeyRecord.id);
            req.auth = {
                userId: 0,
                storeId: apiKeyRecord.store_id,
                role: 'STAFF',
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
        const membershipRecord = db_1.db.prepare(`
      SELECT m.role, m.status as membership_status, s.status as store_status, s.slug as store_slug
      FROM memberships m
      JOIN stores s ON s.id = m.store_id
      WHERE m.user_id = ? AND m.store_id = ?
    `).get(authPayload.userId, authPayload.storeId);
        if (!membershipRecord) {
            res.status(403).json({
                success: false,
                error: { code: 'FORBIDDEN', message: 'Bu mağazaya erişim üyeliğiniz bulunmamaktadır.' }
            });
            return;
        }
        if (membershipRecord.membership_status !== 'active' || membershipRecord.store_status !== 'active') {
            res.status(403).json({
                success: false,
                error: { code: 'FORBIDDEN', message: 'Mağaza üyeliğiniz veya mağaza pasif durumdadır.' }
            });
            return;
        }
        req.auth = {
            userId: authPayload.userId,
            storeId: authPayload.storeId,
            role: (membershipRecord.role || authPayload.role),
            email: authPayload.email,
            storeSlug: membershipRecord.store_slug,
            tokenType: 'jwt'
        };
        next();
    }
    /**
     * Master Admin Middleware - Enforces Master Admin (Store ID 1 & OWNER role)
     */
    static requireMasterAdmin(req, res, next) {
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
    static requireRole(allowedRoles) {
        return (req, res, next) => {
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
    static logAudit(storeId, userId, action, entityType, entityId = '', oldValue = '', newValue = '') {
        try {
            db_1.db.prepare(`
        INSERT INTO audit_logs (store_id, user_id, action, entity_type, entity_id, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(storeId, userId, action, entityType, entityId, oldValue, newValue);
        }
        catch (e) {
            console.warn('[Audit Log Warning]:', e.message);
        }
    }
    /**
     * Production CORS Whitelist Middleware
     */
    static cors(req, res, next) {
        const origin = req.headers.origin;
        const allowedOrigins = env_1.env.corsOrigins === '*' ? '*' : env_1.env.corsOrigins.split(',');
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
exports.AuthMiddleware = AuthMiddleware;
