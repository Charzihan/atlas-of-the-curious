/* Shared plumbing for the headless-browser checks (scripts/check-text.mjs and
   scripts/smoke.mjs): pick a free port, run the project's own dev server on
   it, and open Playwright's Chromium.

   Nothing here ships with the site — it is development tooling only. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Ask the OS for an unused port, then hand it to server.mjs. There is a
// microscopic race between closing this probe and the server binding; on a
// developer machine or CI runner that is fine.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Starts server.mjs and resolves once it reports that it is listening.
export async function startServer({ timeoutMs = 10000 } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1" }
  });

  const origin = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`dev server did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes(String(port))) { clearTimeout(timer); resolve(); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited early (code ${code})`));
    });
  });

  return { origin, port, stop };
}

// Loads Playwright lazily so a missing devDependency is a clear message
// rather than an import crash. Returns null when it cannot be used.
export async function launchChromium(options = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return { browser: null, reason: `playwright is not installed (${err.message})` };
  }
  try {
    const browser = await chromium.launch({ ...options });
    return { browser, reason: null };
  } catch (err) {
    // Playwright's launch error carries a multi-line install banner; the first
    // line is the actual reason.
    const first = String(err.message).split("\n")[0].trim();
    return { browser: null, reason: `chromium could not be launched (${first})` };
  }
}

export const INSTALL_HINT =
  "pnpm add -D playwright && pnpm exec playwright install --with-deps chromium";
