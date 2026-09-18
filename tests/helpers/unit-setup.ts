// Unit tests never touch real infrastructure; provide deterministic secrets.
process.env.SESSION_SECRET ??= 'unit-test-session-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:1/unused';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.EMAIL_PROVIDER ??= 'console';
