// Tests must never inherit the production database path from .env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = process.env.TEST_DATABASE_PATH || './test-data/iscworks-tests.db';
process.env.MASTER_ADMIN_PANEL_PATH = 'platform-test-console';
