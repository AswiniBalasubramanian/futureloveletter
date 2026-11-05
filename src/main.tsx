import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect } from "react";
import { bind } from "cuelume";
import "@fontsource/special-elite";
import "@fontsource-variable/cormorant-garamond";
import "@fontsource-variable/cormorant-garamond/wght-italic.css";
import "@fontsource/pinyon-script";
import "./styles.css";
import { usePath } from "./router";
import Landing from "./landing/Landing";
import { Privacy, Terms, NotFound } from "./Pages";

const App = lazy(() => import("./App"));
const Admin = lazy(() => import("./Admin"));

function Root() {
  const path = usePath();
  useEffect(() => bind(), []);
  if (path === "/") return <Landing />;
  if (path === "/write") return <Suspense fallback={null}><App /></Suspense>;
  if (path === "/admin") return <Suspense fallback={null}><Admin /></Suspense>;
  if (path === "/privacy") return <Privacy />;
  if (path === "/terms") return <Terms />;
  return <NotFound />;
}

createRoot(document.getElementById("root")!).render(<Root />);
