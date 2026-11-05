import { useCallback, useEffect, useState, type FormEvent } from "react";
import { go } from "./router";
import { WaxSeal } from "./Postal";
import "./landing/landing.css";
import "./admin.css";

type Row = {
  id: string; kind: "self" | "loved"; to_name: string; email: string; from_name: string;
  deliver_at: string; deliver_label: string | null; sealed_at: string;
  status: "scheduled" | "sent" | "failed" | "cancelled"; attempts: number; last_error: string | null; sent_at: string | null;
};
type Data = { letters: Row[]; counts: Record<string, number>; transport: string };

const TABS = [
  { key: "", label: "All" },
  { key: "scheduled", label: "Waiting" },
  { key: "sent", label: "Delivered" },
  { key: "failed", label: "Failed" },
  { key: "cancelled", label: "Cancelled" },
] as const;
const LABEL: Record<Row["status"], string> = { scheduled: "Waiting", sent: "Delivered", failed: "Failed", cancelled: "Cancelled" };

const KEY = "fll-admin";
const readToken = () => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const saveToken = (t: string) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage blocked: stays signed in for this page only */ } };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

/** "in 3 days", "2 hours ago" */
function relative(iso: string) {
  const diff = Date.parse(iso) - Date.now();
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000_000], ["month", 2_592_000_000], ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of steps) if (Math.abs(diff) >= ms || unit === "minute") return rtf.format(Math.round(diff / ms), unit);
  return "";
}

export default function Admin() {
  const [token, setToken] = useState(readToken);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => { document.title = "Post room · Future Love Letter"; document.documentElement.classList.remove("app-mode"); }, []);

  const call = useCallback(async (path: string, method = "GET") => {
    const res = await fetch(path, { method, headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { saveToken(""); setToken(""); throw new Error(body.error ?? "Sign in again."); }
    if (!res.ok) throw new Error(body.error ?? "The post office didn't answer.");
    return body;
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setData(await call(`/api/admin/letters${tab ? `?status=${tab}` : ""}`));
      setError("");
    } catch (e) { setError((e as Error).message); }
  }, [call, tab, token]);

  useEffect(() => { void load(); }, [load]);

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    saveToken(draft.trim());
    setToken(draft.trim());
    setDraft("");
  };

  const act = async (row: Row, what: "send" | "retry" | "cancel") => {
    if (what === "cancel" && !confirm(`Cancel the letter to ${row.kind === "self" ? row.email : row.to_name}? It will never be delivered.`)) return;
    setBusy(row.id);
    setNotice("");
    try {
      const r = await call(`/api/admin/letters/${row.id}/${what}`, "POST");
      setNotice(
        what === "cancel" ? "Letter cancelled." :
        r.status === "sent" ? `Delivered to ${row.email}.` :
        r.lastError ? `Still not delivered: ${r.lastError}` : "Back in the queue. It goes out on the next post round.",
      );
      await load();
    } catch (e) { setNotice((e as Error).message); }
    setBusy(null);
  };

  if (!token) {
    return (
      <main className="lp lp-page">
        <form className="lp-paper adm-login" onSubmit={signIn}>
          <a href="/" className="lp-back" onClick={(e) => { e.preventDefault(); go("/"); }}>← Back to Future Love Letter</a>
          <div className="adm-login-seal"><WaxSeal size={64} flowers={false} tone="red" /></div>
          <h1>The post room</h1>
          <p>Every sealed letter, where it is, and when it opens. For the owner of this post office only.</p>
          <label className="adm-field">
            <span>Dashboard password</span>
            <input type="password" autoComplete="current-password" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          </label>
          {error && <p className="adm-error" role="alert">{error}</p>}
          <button className="adm-btn primary" type="submit">Open the post room</button>
          <p className="adm-hint">The password is the <code>ADMIN_TOKEN</code> value set on the server.</p>
        </form>
      </main>
    );
  }

  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const next = data?.letters.filter((l) => l.status === "scheduled").sort((a, b) => a.deliver_at.localeCompare(b.deliver_at))[0];

  return (
    <main className="lp adm">
      <header className="adm-head">
        <div>
          <a href="/" className="lp-back" onClick={(e) => { e.preventDefault(); go("/"); }}>← Future Love Letter</a>
          <h1>The post room</h1>
        </div>
        <div className="adm-head-actions">
          <button className="adm-btn" data-cuelume-tap onClick={() => void load()}>Refresh</button>
          <button className="adm-btn ghost" onClick={() => { saveToken(""); setToken(""); setData(null); }}>Sign out</button>
        </div>
      </header>

      <section className="adm-stats" aria-label="Totals">
        <div><span>All letters</span><strong>{total}</strong></div>
        <div><span>Waiting</span><strong>{counts.scheduled ?? 0}</strong></div>
        <div><span>Delivered</span><strong>{counts.sent ?? 0}</strong></div>
        <div className={counts.failed ? "warn" : ""}><span>Failed</span><strong>{counts.failed ?? 0}</strong></div>
        <div className="adm-next"><span>Next to open</span><strong>{next ? relative(next.deliver_at) : "—"}</strong>{next && <em>{next.kind === "self" ? next.email : next.to_name}</em>}</div>
      </section>

      <nav className="adm-tabs" aria-label="Filter letters">
        {TABS.map((t) => (
          <button key={t.key} aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}<span>{t.key ? counts[t.key] ?? 0 : total}</span>
          </button>
        ))}
        <span className="adm-transport">Mail via {data?.transport ?? "…"}</span>
      </nav>

      {error && <p className="adm-error" role="alert">{error}</p>}
      {notice && <p className="adm-notice" role="status">{notice}</p>}

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr><th>Letter</th><th>Opens</th><th>Sealed</th><th>Status</th><th><span className="sr">Actions</span></th></tr>
          </thead>
          <tbody>
            {data && data.letters.length === 0 && (
              <tr><td colSpan={5} className="adm-empty">No letters here yet. Sealed letters appear the moment they're posted.</td></tr>
            )}
            {!data && !error && <tr><td colSpan={5} className="adm-empty">Opening the mailbags…</td></tr>}
            {data?.letters.map((l) => (
              <tr key={l.id}>
                <td>
                  <strong>{l.kind === "self" ? "Future self" : l.to_name}</strong>
                  <span>{l.email}</span>
                  <span className="adm-from">from {l.from_name}</span>
                </td>
                <td>
                  <strong>{l.deliver_label ?? when(l.deliver_at)}</strong>
                  <span>{l.status === "sent" ? `delivered ${when(l.sent_at)}` : relative(l.deliver_at)}</span>
                </td>
                <td><span>{when(l.sealed_at)}</span></td>
                <td>
                  <span className={`adm-pill is-${l.status}`}>{LABEL[l.status]}</span>
                  {l.attempts > 0 && l.status !== "sent" && <span className="adm-err" title={l.last_error ?? ""}>{l.attempts} failed {l.attempts === 1 ? "try" : "tries"}{l.last_error ? `: ${l.last_error.slice(0, 80)}` : ""}</span>}
                </td>
                <td className="adm-actions">
                  {(l.status === "scheduled" || l.status === "failed") && (
                    <button className="adm-btn small" disabled={busy === l.id} onClick={() => void act(l, "send")}>{busy === l.id ? "Sending…" : "Send now"}</button>
                  )}
                  {l.status === "failed" && <button className="adm-btn small ghost" disabled={busy === l.id} onClick={() => void act(l, "retry")}>Retry later</button>}
                  {(l.status === "scheduled" || l.status === "failed") && <button className="adm-btn small danger" disabled={busy === l.id} onClick={() => void act(l, "cancel")}>Cancel</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="adm-privacy">Letters stay sealed here: the dashboard shows who, where and when, never what was written.</p>
    </main>
  );
}
