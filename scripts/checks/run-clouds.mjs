/* Dev-only: run just the cloud checks (scripts/checks/clouds.mjs) without the
   rest of the smoke suite, for a fast edit/look loop. The geometry half also
   runs on its own with `node scripts/checks/clouds.mjs` (no browser).
     node scripts/checks/run-clouds.mjs */
import { startServer, launchChromium, INSTALL_HINT } from "../browser-harness.mjs";
import { runCloudChecks } from "./clouds.mjs";

const { browser, reason } = await launchChromium();
if (!browser) {
  console.error(`error: ${reason}\n  install with: ${INSTALL_HINT}`);
  process.exit(1);
}
let failed = false;
const fail = (m) => { console.error(`  error: ${m}`); failed = true; };
const server = await startServer();
try {
  await runCloudChecks(browser, server.origin, fail);
} catch (err) {
  console.error(err.stack || err.message);
  failed = true;
} finally {
  await server.stop();
  await browser.close();
}
console.log(failed ? "\ncloud checks FAILED" : "\ncloud checks OK");
process.exit(failed ? 1 : 0);
