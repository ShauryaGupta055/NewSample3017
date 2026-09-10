const { createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { basename, extname, join } = require("node:path");

const port = Number(process.env.PORT || 3000);
const indexPath = join(__dirname, "index.html");
const assetsDir = join(__dirname, "assets");

const mimeTypes = {
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const server = createServer((request, response) => {
  const path = (request.url || "/").split("?")[0];

  if (path === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (path.startsWith("/assets/")) {
    // basename() strips any directory traversal before touching the filesystem.
    const file = join(assetsDir, basename(path));
    const type = mimeTypes[extname(file).toLowerCase()];

    if (type && existsSync(file) && statSync(file).isFile()) {
      response.writeHead(200, {
        "cache-control": "public, max-age=3600",
        "content-type": type,
      });
      createReadStream(file).pipe(response);
      return;
    }
  }

  if (path !== "/" && path !== "/index.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  createReadStream(indexPath).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`NewSample3017 listening on http://0.0.0.0:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
