import Anthropic from "@anthropic-ai/sdk";

// languages offered in the editor; the key is what the client sends
export const LANGUAGES: Record<string, string> = {
  ta: "Tamil", hi: "Hindi", fr: "French", es: "Spanish", de: "German", it: "Italian",
  pt: "Portuguese", ja: "Japanese", ko: "Korean", zh: "Simplified Chinese", ar: "Arabic",
  bn: "Bengali", te: "Telugu", ml: "Malayalam", kn: "Kannada", mr: "Marathi", ur: "Urdu", en: "English",
};

const SYSTEM = `You translate personal letters. The writer typed this on a typewriter for someone they love, to be opened years from now.
Translate the whole letter into the target language so it reads as if it had been written in that language by the same person: keep their warmth, their plainness or their formality, and their voice.
Keep every line break and blank line exactly where it is. Translate the salutation and sign-off naturally for that language, and keep people's names as written.
Reply with the translated letter only: no title, no notes, no quotation marks around it.`;

// one client for the process; credentials come from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile)
let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export class TranslateError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function translate(text: string, lang: string): Promise<string> {
  const target = LANGUAGES[lang];
  if (!target) throw new TranslateError("Choose a language from the list.", 400);
  if (!text.trim()) throw new TranslateError("There is nothing to translate yet.", 400);

  try {
    const response = await getClient().beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // translation is routine work: low effort keeps it quick
      output_config: { effort: "low" },
      // if a safety classifier declines, the API retries on a suitable model inside the same call
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Target language: ${target}\n\n<letter>\n${text}\n</letter>` }],
    });
    if (response.stop_reason === "refusal") throw new TranslateError("This letter couldn't be translated.", 422);
    const out = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!out) throw new TranslateError("The translation came back empty. Try again.", 502);
    return out;
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new TranslateError("Translation isn't set up on this server yet. Add ANTHROPIC_API_KEY to .env.", 503);
    }
    if (err instanceof Anthropic.RateLimitError) throw new TranslateError("Too many translations right now. Try again in a minute.", 429);
    if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) throw new TranslateError("The Anthropic account behind this server has no credits left. Add credits in Plans & Billing.", 402);
    if (err instanceof Anthropic.APIError) throw new TranslateError("The translator hit a snag. Try again.", 502);
    // missing credentials surface as a plain Error from the client constructor or request
    if (err instanceof Error && /api ?key|auth/i.test(err.message)) {
      throw new TranslateError("Translation isn't set up on this server yet. Add ANTHROPIC_API_KEY to .env.", 503);
    }
    throw err;
  }
}

// tones offered in the editor; the key is what the client sends
export const TONES: Record<string, string> = {
  poetic: "lyrical and poetic, with gentle imagery, rhythm and metaphor, but no forced rhyme",
  romantic: "tender and romantic, warm and intimate",
  heartfelt: "sincere and heartfelt, with simple, honest feeling",
  playful: "light, playful and affectionate, with a little wit",
  formal: "graceful and formal, like a letter from another century",
  simple: "simpler and clearer, in short, plain sentences",
};

const REPHRASE_SYSTEM = `You rewrite passages from personal letters, written by someone to a person they love, to be opened years from now.
Keep the meaning, the names and the language the passage is written in. Keep every line break where it is.
Reply with the rewritten passage only: no title, no notes, no quotation marks.`;

export async function rephrase(text: string, tone: string): Promise<string> {
  const ask = TONES[tone];
  if (!ask) throw new TranslateError("Choose a tone from the list.", 400);
  if (!text.trim()) throw new TranslateError("There is nothing to rephrase yet.", 400);
  try {
    const response = await getClient().beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: REPHRASE_SYSTEM,
      messages: [{ role: "user", content: `Rewrite this to be ${ask}:\n\n<passage>\n${text}\n</passage>` }],
    });
    if (response.stop_reason === "refusal") throw new TranslateError("This passage couldn't be rephrased.", 422);
    const out = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!out) throw new TranslateError("The rephrasing came back empty. Try again.", 502);
    return out;
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new TranslateError("Rephrasing on the server isn't set up (no Anthropic key).", 503);
    if (err instanceof Anthropic.RateLimitError) throw new TranslateError("Too many requests right now. Try again in a minute.", 429);
    if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) throw new TranslateError("The Anthropic account behind this server has no credits left. Add credits in Plans & Billing.", 402);
    if (err instanceof Anthropic.APIError) throw new TranslateError("The rephraser hit a snag. Try again.", 502);
    if (err instanceof Error && /api ?key|auth/i.test(err.message)) throw new TranslateError("Rephrasing on the server isn't set up (no Anthropic key).", 503);
    throw err;
  }
}
