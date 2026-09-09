/* Minimal zero-dependency static file server for local development.
   Run: pnpm start  (or: node server.mjs [port])
   Use any real static host (nginx, GitHub Pages, Netlify, …) for production. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const filePath = resolve(root, normalize("." + pathname));
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    let st = await stat(filePath).catch(() => null);
    if (st && st.isDirectory()) {
      st = await stat(join(filePath, "index.html")).catch(() => null);
      if (!st) { res.writeHead(404); return res.end("Not found"); }
    }
    if (!st) { res.writeHead(404); return res.end("Not found"); }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Atlas of the Curious → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log("Press Ctrl+C to stop. (Development server only.)");
});
