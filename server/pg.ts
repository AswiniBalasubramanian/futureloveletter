import { neon } from "@neondatabase/serverless";
import type { LetterRow } from "./db.ts";
import { backoff, SUMMARY_COLS, type LetterSummary, type Store } from "./store.ts";

// Postgres over HTTP (Neon), for serverless hosts with no disk. Times are ISO strings, as in SQLite.
const sql = neon(process.env.DATABASE_URL!);

let ready: Promise<unknown> | null = null;
const init = () =>
  (ready ??= sql
    .query(`CREATE TABLE IF NOT EXISTS letters (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      to_name TEXT NOT NULL,
      email TEXT NOT NULL,
      from_name TEXT NOT NULL,
      text TEXT NOT NULL,
      image TEXT,
      deliver_on TEXT NOT NULL,
      deliver_at TEXT NOT NULL,
      deliver_label TEXT,
      sealed_at TEXT NOT NULL,
      created_ip TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TEXT,
      next_try_at TEXT
    )`)
    .then(() => sql.query("CREATE INDEX IF NOT EXISTS letters_due ON letters (status, deliver_at)"))
    .catch((err) => { ready = null; throw err; }));

const q = async (text: string, params: unknown[] = []) => {
  await init();
  return (await sql.query(text, params)) as Record<string, unknown>[];
};

export const store: Store = {
  async insertLetter(l) {
    await q(
      `INSERT INTO letters (id, kind, to_name, email, from_name, text, image, deliver_on, deliver_at, deliver_label, sealed_at, created_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [l.id, l.kind, l.to_name, l.email, l.from_name, l.text, l.image, l.deliver_on, l.deliver_at, l.deliver_label, l.sealed_at, l.created_ip],
    );
  },
  async getLetter(id) {
    return (await q("SELECT * FROM letters WHERE id = $1", [id]))[0] as LetterRow | undefined;
  },
  async claimDue(now) {
    const lease = new Date(Date.now() + 10 * 60_000).toISOString();
    return (await q(
      `UPDATE letters SET next_try_at = $2 WHERE id IN (
         SELECT id FROM letters WHERE status = 'scheduled' AND deliver_at <= $1 AND (next_try_at IS NULL OR next_try_at <= $1)
         ORDER BY deliver_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [now, lease],
    )) as LetterRow[];
  },
  async markSent(id) {
    await q("UPDATE letters SET status = 'sent', sent_at = $2, image = NULL, last_error = NULL, next_try_at = NULL WHERE id = $1", [id, new Date().toISOString()]);
  },
  async markFailed(id, error, attempts, giveUp) {
    await q("UPDATE letters SET attempts = $2, last_error = $3, status = $4, next_try_at = $5 WHERE id = $1", [id, attempts, error.slice(0, 500), giveUp ? "failed" : "scheduled", backoff(attempts)]);
  },
  async recentFromIp(ip, sinceIso) {
    return Number((await q("SELECT COUNT(*) AS n FROM letters WHERE created_ip = $1 AND sealed_at >= $2", [ip, sinceIso]))[0]?.n ?? 0);
  },
  async makeDue(id) {
    await q("UPDATE letters SET deliver_at = $2, next_try_at = NULL WHERE id = $1 AND status = 'scheduled'", [id, new Date().toISOString()]);
  },
  async list(status, limit) {
    return (status
      ? await q(`SELECT ${SUMMARY_COLS} FROM letters WHERE status = $1 ORDER BY sealed_at DESC LIMIT $2`, [status, limit])
      : await q(`SELECT ${SUMMARY_COLS} FROM letters ORDER BY sealed_at DESC LIMIT $1`, [limit])) as LetterSummary[];
  },
  async counts() {
    const rows = await q("SELECT status, COUNT(*) AS n FROM letters GROUP BY status");
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  },
  async cancel(id) {
    return (await q("UPDATE letters SET status = 'cancelled', image = NULL WHERE id = $1 AND status IN ('scheduled', 'failed') RETURNING id", [id])).length > 0;
  },
  async retry(id) {
    return (await q("UPDATE letters SET status = 'scheduled', attempts = 0, next_try_at = NULL, last_error = NULL WHERE id = $1 AND status = 'failed' RETURNING id", [id])).length > 0;
  },
};
