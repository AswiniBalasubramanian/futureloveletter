import { getStore } from "./store.ts";
import { send } from "./mail.ts";
import { letterMail } from "./template.ts";

const MAX_ATTEMPTS = 8;
let running = false;

/** Sends every letter whose moment has come. Safe to call any time; overlapping runs are skipped. */
export async function tick() {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const store = await getStore();
    for (const l of await store.claimDue(new Date().toISOString())) {
      try {
        await send(letterMail(l));
        await store.markSent(l.id);
        sent++;
        console.log(`[post] delivered ${l.id} to ${l.email}`);
      } catch (err) {
        const attempts = l.attempts + 1;
        await store.markFailed(l.id, String(err), attempts, attempts >= MAX_ATTEMPTS);
        console.error(`[post] attempt ${attempts} for ${l.id} failed:`, err);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

/** The always-on server's post round. On Vercel, /api/tick is called on a schedule instead. */
export function startScheduler(everyMs = Number(process.env.TICK_MS ?? 60_000)) {
  void tick();
  return setInterval(tick, everyMs);
}
