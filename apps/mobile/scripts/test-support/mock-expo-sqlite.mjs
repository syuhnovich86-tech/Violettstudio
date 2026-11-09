import { DatabaseSync } from 'node:sqlite';

export async function openDatabaseAsync() {
  const db = new DatabaseSync(process.env.VIOLETTA_TEST_DB);
  return {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, ...args) { return db.prepare(sql).run(...args); },
    async getFirstAsync(sql, ...args) { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
    async getAllAsync(sql, ...args) { return db.prepare(sql).all(...args).map((row) => ({ ...row })); },
    async withTransactionAsync(fn) { db.exec('BEGIN'); try { await fn(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
}
