# ISCWORKS production checklist

## Required environment

- Use a unique `JWT_SECRET` of at least 32 characters.
- Set `CORS_ORIGINS=https://www.iscworks.tr` in production; wildcard CORS is rejected.
- Keep `DATABASE_PATH` on persistent storage.
- Configure `RESEND_API_KEY`, `EMAIL_FROM`, Gemini and Meta credentials only in `.env`.

## Deploy

```sh
git pull origin main
npm ci
npm run build
npm test
pm2 restart proje2 --update-env
curl --fail http://127.0.0.1:3000/healthz
```

`dist/` is intentionally not committed. Every deployment builds it from the reviewed TypeScript source.

## Backups

`npm run backup` creates a SQLite online backup under `backups/`. Schedule it daily and copy backups to a separate machine or object-storage account. Test a restore at least monthly.

Example daily cron entry:

```cron
20 3 * * * cd /home/iscenkalemre/proje2 && /usr/bin/npm run backup >> /home/iscenkalemre/proje2/backup.log 2>&1
```

Keep at least 7 daily and 4 weekly copies outside the VPS. The application automatically removes expired temporary tokens, old webhook idempotency records and messages older than `DATA_RETENTION_DAYS`.
