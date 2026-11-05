import { handle } from "../server/app.ts";

// Every /api/* request on Vercel lands here (see vercel.json); the post office router does the rest.
export default handle;
