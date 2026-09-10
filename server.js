const { createReadStream } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");

const port = Number(process.env.PORT || 3000);
const indexPath = join(__dirname, "index.html");

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (request.url !== "/" && request.url !== "/index.html") {
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
