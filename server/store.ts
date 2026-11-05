import type { LetterRow } from "./db.ts";

export type NewLetter = Omit<LetterRow, "status" | "attempts" | "last_error" | "sent_at">;

/** Where sealed letters wait. SQLite on a disk locally (and on Render), Postgres on Vercel. */
export type Store = {
  insertLetter(l: NewLetter): Promise<void>;
  getLetter(id: string): Promise<LetterRow | undefined>;
  /** Letters whose moment has come, leased for a few minutes so two post rounds never send one twice. */
  claimDue(now: string): Promise<LetterRow[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string, attempts: number, giveUp: boolean): Promise<void>;
  recentFromIp(ip: string, sinceIso: string): Promise<number>;
  /** make a scheduled letter due now (dev testing, and "Send now" in the dashboard) */
  makeDue(id: string): Promise<void>;
  /** dashboard: newest first, without the letter itself */
  list(status: string | null, limit: number): Promise<LetterSummary[]>;
  counts(): Promise<Record<string, number>>;
  cancel(id: string): Promise<boolean>;
  retry(id: string): Promise<boolean>;
};

export type LetterSummary = Pick<LetterRow, "id" | "kind" | "to_name" | "email" | "from_name" | "deliver_at" | "deliver_label" | "sealed_at" | "status" | "attempts" | "last_error" | "sent_at">;
export const SUMMARY_COLS = "id, kind, to_name, email, from_name, deliver_at, deliver_label, sealed_at, status, attempts, last_error, sent_at";

/** Retry later after a failed send: 1h, 2h, 4h … capped at a day. */
export const backoff = (attempts: number) => new Date(Date.now() + Math.min(2 ** attempts, 48) * 30 * 60_000).toISOString();

let store: Promise<Store> | null = null;
export const getStore = () =>
  (store ??= process.env.DATABASE_URL
    ? import("./pg.ts").then((m) => m.store)
    : import("./db.ts").then((m) => m.store));
