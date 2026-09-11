import { startServer, launchChromium } from '../browser-harness.mjs';
import { runMapArtChecks } from './map-art.mjs';
import { runMapArtExtraChecks } from './map-art-extra.mjs';
const { browser, reason } = await launchChromium();
if (!browser) throw new Error(reason);
let server;
try { server = await startServer(); if (!process.argv.includes("--extra-only")) await runMapArtChecks(browser, server.origin); await runMapArtExtraChecks(browser, server.origin); }
finally { if (server) await server.stop(); await browser.close(); }
