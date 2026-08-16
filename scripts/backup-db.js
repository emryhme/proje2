const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const sourcePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './barons.db');
if (!fs.existsSync(sourcePath)) {
  console.error(`Veritabanı bulunamadı: ${sourcePath}`);
  process.exit(1);
}

const backupDirectory = path.resolve(process.cwd(), 'backups');
fs.mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const destinationPath = path.join(backupDirectory, `barons-${timestamp}.db`);
const database = new Database(sourcePath, { readonly: true });

database.backup(destinationPath)
  .then(() => {
    database.close();
    console.log(`Yedek oluşturuldu: ${destinationPath}`);
  })
  .catch((error) => {
    database.close();
    console.error('Yedek oluşturulamadı:', error.message);
    process.exit(1);
  });
