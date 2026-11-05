import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backoff, SUMMARY_COLS, type LetterSummary, type Store } from "./store.ts";

export type LetterRow = {
  id: string;
  kind: "self" | "loved";
  to_name: string;
  email: string;
  from_name: string;
  text: string;
  image: string | null; // the typed page as a JPEG data URL
  deliver_on: string; // yyyy-mm-dd, as the writer chose it
  deliver_at: string; // UTC instant it becomes due
  deliver_label: string | null; // "26 October 2027 at 9:00 am", in the writer's time zone
  sealed_at: string;
  created_ip: string;
  status: "scheduled" | "sent" | "failed" | "cancelled";
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
};

const file = process.env.DB_PATH ?? "data/letters.db";
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS letters (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    to_name TEXT NOT NULL,
    email TEXT NOT NULL,
    from_name TEXT NOT NULL,
    text TEXT NOT NULL,
    image TEXT,
    deliver_on TEXT NOT NULL,
    deliver_at TEXT NOT NULL,
    sealed_at TEXT NOT NULL,
    created_ip TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TEXT,
    next_try_at TEXT
  );
  CREATE INDEX IF NOT EXISTS letters_due ON letters (status, deliver_at);
`);
try { db.exec("ALTER TABLE letters ADD COLUMN deliver_label TEXT"); } catch { /* already there */ }

export function insertLetter(l: Omit<LetterRow, "status" | "attempts" | "last_error" | "sent_at">) {
  db.prepare(`INSERT INTO letters (id, kind, to_name, email, from_name, text, image, deliver_on, deliver_at, deliver_label, sealed_at, created_ip)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(l.id, l.kind, l.to_name, l.email, l.from_name, l.text, l.image, l.deliver_on, l.deliver_at, l.deliver_label, l.sealed_at, l.created_ip);
}

export const getLetter = (id: string) => db.prepare("SELECT * FROM letters WHERE id = ?").get(id) as LetterRow | undefined;

/** Letters whose day has come and that are not waiting out a retry. */
export function dueLetters(now: string, limit = 20) {
  return db.prepare(`SELECT * FROM letters WHERE status = 'scheduled' AND deliver_at <= ? AND (next_try_at IS NULL OR next_try_at <= ?)
                     ORDER BY deliver_at LIMIT ?`).all(now, now, limit) as LetterRow[];
}

export function markSent(id: string) {
  // the page image is only needed for delivery, so it goes once the letter has
  db.prepare("UPDATE letters SET status = 'sent', sent_at = ?, image = NULL, last_error = NULL WHERE id = ?").run(new Date().toISOString(), id);
}

export function markFailed(id: string, error: string, attempts: number, giveUp: boolean) {

  db.prepare("UPDATE letters SET attempts = ?, last_error = ?, status = ?, next_try_at = ? WHERE id = ?")
    .run(attempts, error.slice(0, 500), giveUp ? "failed" : "scheduled", backoff(attempts), id);
}

export const recentFromIp = (ip: string, sinceIso: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM letters WHERE created_ip = ? AND sealed_at >= ?").get(ip, sinceIso) as { n: number }).n;

export const store: Store = {
  insertLetter: async (l) => insertLetter(l),
  getLetter: async (id) => getLetter(id),
  // one process runs the post round here, so no lease is needed
  claimDue: async (now) => dueLetters(now),
  markSent: async (id) => markSent(id),
  markFailed: async (id, error, attempts, giveUp) => markFailed(id, error, attempts, giveUp),
  recentFromIp: async (ip, since) => recentFromIp(ip, since),
  makeDue: async (id) => { db.prepare("UPDATE letters SET deliver_at = ?, next_try_at = NULL WHERE id = ? AND status = 'scheduled'").run(new Date().toISOString(), id); },
  list: async (status, limit) => (status
    ? db.prepare(`SELECT ${SUMMARY_COLS} FROM letters WHERE status = ? ORDER BY sealed_at DESC LIMIT ?`).all(status, limit)
    : db.prepare(`SELECT ${SUMMARY_COLS} FROM letters ORDER BY sealed_at DESC LIMIT ?`).all(limit)) as LetterSummary[],
  counts: async () => Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM letters GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n])),
  cancel: async (id) => db.prepare("UPDATE letters SET status = 'cancelled', image = NULL WHERE id = ? AND status IN ('scheduled', 'failed')").run(id).changes > 0,
  retry: async (id) => db.prepare("UPDATE letters SET status = 'scheduled', attempts = 0, next_try_at = NULL, last_error = NULL WHERE id = ? AND status = 'failed'").run(id).changes > 0,
};
