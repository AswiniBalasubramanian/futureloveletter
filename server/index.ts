import { createServer } from "node:http";
import { handle } from "./app.ts";
import { transport } from "./mail.ts";
import { startScheduler } from "./scheduler.ts";

// The always-on post office: serves the built site and the API, and runs the post round every minute.
const PORT = Number(process.env.PORT ?? 8787);

createServer(handle).listen(PORT, () => {
  console.log(`[post] listening on http://localhost:${PORT} · mail via ${transport}${transport === "files" ? " (data/mail/*.eml)" : ""}${process.env.DATABASE_URL ? " · letters in Postgres" : ""}`);
  startScheduler();
});
