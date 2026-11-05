import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { getStore } from "./store.ts";
import { transport } from "./mail.ts";
import { tick } from "./scheduler.ts";
import { translate, rephrase, TranslateError, LANGUAGES } from "./translate.ts";

const DEV_DELIVER = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_DELIVER === "1";
const MAX_BODY = 3_000_000;
const PER_HOUR = Number(process.env.LETTERS_PER_HOUR ?? 10);
const DIST = "dist";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const STATUSES = ["scheduled", "sent", "failed", "cancelled"];

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Letter too large"), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const ip = (req: IncomingMessage) => (process.env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** True when the request carries `Bearer <secret>`. Compared in constant time. */
function bearer(req: IncomingMessage, secret: string | undefined) {
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Checks a sealed letter and turns it into a row, or says what is wrong with it. */
function validate(b: Record<string, unknown>) {
  const kind = b.kind === "self" ? "self" : b.kind === "loved" ? "loved" : null;
  const email = str(b.email, 254);
  const to = str(b.to, 40);
  const from = str(b.from, 40);
  const text = typeof b.text === "string" ? b.text.slice(0, 4000) : "";
  const deliverOn = str(b.deliver, 10);
  const deliverAt = Date.parse(str(b.deliverAt, 40));
  const image = typeof b.image === "string" && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b.image) && b.image.length < 2_800_000 ? b.image : null;
  if (!kind) return "Choose who the letter is for.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email address doesn't look right.";
  if (kind === "loved" && !to) return "Add the name of the person it's for.";
  if (!from) return "Sign the letter with your name.";
  if (text.trim().length < 2) return "The letter is empty.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliverOn) || Number.isNaN(deliverAt)) return "Pick a delivery date.";
  if (deliverAt < Date.now() + 2 * 60_000) return "The delivery time has to be in the future.";
  if (deliverAt > Date.now() + 100 * 365 * 86_400_000) return "That's further than we can promise to keep it.";
  return { kind, email, to_name: kind === "self" ? "Future me" : to, from_name: from, text, image, deliver_on: deliverOn, deliver_at: new Date(deliverAt).toISOString(), deliver_label: str(b.deliverLabel, 60) || null } as const;
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!existsSync(DIST)) return false;
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

/** Every route of the post office. Runs inside the always-on server (index.ts) or as one Vercel function (api/index.ts). */
export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  // Vercel rewrites /api/* to the single function and passes the original path along
  const path = url.searchParams.get("__path") != null ? `/api/${url.searchParams.get("__path")}` : url.pathname;
  try {
    if (req.method === "GET" && path === "/api/health") return json(res, 200, { ok: true, transport });

    if (req.method === "POST" && path === "/api/letters") {
      const store = await getStore();
      const who = ip(req);
      if ((await store.recentFromIp(who, new Date(Date.now() - 3_600_000).toISOString())) >= PER_HOUR) return json(res, 429, { error: "That's a lot of letters for one hour. Try again a little later." });
      const v = validate(await readBody(req));
      if (typeof v === "string") return json(res, 400, { error: v });
      const id = randomUUID();
      await store.insertLetter({ id, ...v, sealed_at: new Date().toISOString(), created_ip: who });
      return json(res, 201, { id, status: "scheduled", deliverAt: v.deliver_at });
    }

    if (req.method === "GET" && path === "/api/languages") return json(res, 200, LANGUAGES);
    if (req.method === "POST" && (path === "/api/translate" || path === "/api/rephrase")) {
      const b = await readBody(req);
      const text = typeof b.text === "string" ? b.text.slice(0, 4000) : "";
      try {
        return json(res, 200, { text: path === "/api/translate" ? await translate(text, String(b.lang ?? "")) : await rephrase(text, String(b.tone ?? "")) });
      } catch (err) {
        if (err instanceof TranslateError) return json(res, err.status, { error: err.message });
        throw err;
      }
    }

    const one = path.match(/^\/api\/letters\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && one) {
      const l = await (await getStore()).getLetter(one[1]);
      return l ? json(res, 200, { id: l.id, status: l.status, deliverOn: l.deliver_on, sentAt: l.sent_at }) : json(res, 404, { error: "No such letter." });
    }

    // the post round, called on a schedule where nothing runs in between (Vercel)
    if ((req.method === "GET" || req.method === "POST") && path === "/api/tick") {
      if (!bearer(req, process.env.CRON_SECRET) && !(DEV_DELIVER && !process.env.CRON_SECRET)) return json(res, 401, { error: "Not allowed." });
      return json(res, 200, { sent: await tick() });
    }

    // owner dashboard (/admin)
    if (path.startsWith("/api/admin/")) {
      if (!process.env.ADMIN_TOKEN) return json(res, 503, { error: "The dashboard is off. Set ADMIN_TOKEN on the server to turn it on." });
      if (!bearer(req, process.env.ADMIN_TOKEN)) return json(res, 401, { error: "That password isn't right." });
      const store = await getStore();
      if (req.method === "GET" && path === "/api/admin/letters") {
        const status = url.searchParams.get("status");
        const [letters, counts] = await Promise.all([store.list(status && STATUSES.includes(status) ? status : null, 300), store.counts()]);
        return json(res, 200, { letters, counts, transport });
      }
      const act = path.match(/^\/api\/admin\/letters\/([0-9a-f-]{36})\/(send|retry|cancel)$/);
      if (req.method === "POST" && act) {
        const [, id, what] = act;
        if (what === "cancel") { if (!(await store.cancel(id))) return json(res, 409, { error: "Only letters that haven't been sent can be cancelled." }); }
        else if (what === "retry") { if (!(await store.retry(id))) return json(res, 409, { error: "Only failed letters can be retried." }); }
        else {
          const l = await store.getLetter(id);
          if (l?.status === "failed") await store.retry(id);
          else if (l?.status !== "scheduled") return json(res, 409, { error: "This letter isn't waiting to be sent." });
          await store.makeDue(id);
          await tick();
        }
        const l = await store.getLetter(id);
        return json(res, 200, { id, status: l?.status, lastError: l?.last_error ?? null });
      }
      return json(res, 404, { error: "Not found." });
    }

    // local testing only: make a letter due now and run the post round
    const now = path.match(/^\/api\/dev\/deliver\/([0-9a-f-]{36})$/);
    if (req.method === "POST" && now && DEV_DELIVER) {
      const store = await getStore();
      await store.makeDue(now[1]);
      const sent = await tick();
      return json(res, 200, { sent, letter: (await store.getLetter(now[1]))?.status });
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: "Not found." });
    if (req.method === "GET" && serveStatic(req, res)) return;
    json(res, 404, { error: "Not found." });
  } catch (err) {
    const status = (err as { status?: number }).status ?? (err instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(err);
    json(res, status, { error: status === 500 ? "The post office hit a snag." : (err as Error).message });
  }
}
