/* Dev-only: run just the Phase 5 sea checks (scripts/checks/sea.mjs) without
   the rest of the smoke suite, for a fast edit/measure loop.
     node scripts/checks/run-sea.mjs */
import { startServer, launchChromium, INSTALL_HINT } from "../browser-harness.mjs";
import { runSeaChecks, reportSeaChecks } from "./sea.mjs";

const { browser, reason } = await launchChromium();
if (!browser) {
  console.error(`error: ${reason}\n  install with: ${INSTALL_HINT}`);
  process.exit(1);
}
let failed = false;
const fail = (m) => { console.error(`  error: ${m}`); failed = true; };
const server = await startServer();
try {
  reportSeaChecks(await runSeaChecks(browser, server.origin), fail);
} catch (err) {
  console.error(err.stack || err.message);
  failed = true;
} finally {
  await server.stop();
  await browser.close();
}
console.log(failed ? "\nsea checks FAILED" : "\nsea checks OK");
process.exit(failed ? 1 : 0);
