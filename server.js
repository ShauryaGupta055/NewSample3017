const { createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { basename, extname, join } = require("node:path");

const port = Number(process.env.PORT || 3000);
const indexPath = join(__dirname, "index.html");
const verificationPath = join(__dirname, "verification.html");
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

/*
 * In-memory batch store. This prototype has no OCR engine and no database, so
 * extracted field values are derived deterministically from each file name and
 * are clearly labelled as simulated in the UI.
 */
const batches = new Map();
const MAX_BATCHES = 200;
const BATCH_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const STAGE_MS = 2600;

// References stay unique even after old batches are evicted from the Map.
let sequence = 0;

// Drop stale batches so a long-running container does not hold them forever.
const sweep = () => {
  const cutoff = Date.now() - BATCH_TTL_MS;
  for (const [id, batch] of batches) {
    if (batch.createdAt < cutoff) batches.delete(id);
  }
};
// unref() keeps this timer from holding the process open during shutdown.
setInterval(sweep, 10 * 60 * 1000).unref();

const VILLAGES = ["Rampur", "Kheri", "Bhagwanpur", "Sultanpur", "Chandpur", "Naugaon", "Mahuli", "Dhanaura"];
const TEHSILS = ["Sadar", "Kairana", "Bilari", "Shahabad", "Nakur", "Chhata"];
const DISTRICTS = ["Muzaffarnagar", "Moradabad", "Saharanpur", "Mathura", "Bareilly", "Aligarh"];
const STATES = ["Uttar Pradesh", "Madhya Pradesh", "Rajasthan", "Maharashtra"];
const DOC_TYPES = ["Sale deed", "Mutation entry (RoR)", "Khatauni extract", "Partition deed", "Lease deed"];
const TENURES = ["Bhumidhar with transferable rights", "Bhumidhar with non-transferable rights", "Freehold"];

// Small deterministic string hash so the same file always yields the same record.
const hash = (value) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};

const pick = (list, seed) => list[seed % list.length];

const buildRecord = (file, index) => {
  const seed = hash(file.name + ":" + file.size);
  const pages = 1 + (seed % 6);
  const confidence = 72 + (seed % 27); // 72–98
  const flagged = confidence < 80;

  return {
    id: "DOC-" + String(index + 1).padStart(3, "0"),
    fileName: file.name,
    fileSize: file.size,
    pages,
    confidence,
    status: flagged ? "Needs review" : "Verified",
    fields: [
      { label: "Document type", value: pick(DOC_TYPES, seed >> 2) },
      { label: "Survey / plot no.", value: (100 + (seed % 380)) + "/" + (1 + (seed % 4)) },
      { label: "Khata no.", value: String(1000 + (seed % 8000)) },
      { label: "Village", value: pick(VILLAGES, seed >> 3) },
      { label: "Tehsil", value: pick(TEHSILS, seed >> 4) },
      { label: "District", value: pick(DISTRICTS, seed >> 5) },
      { label: "State", value: pick(STATES, seed >> 6) },
      { label: "Recorded area", value: (0.2 + ((seed % 480) / 100)).toFixed(2) + " hectare" },
      { label: "Tenure class", value: pick(TENURES, seed >> 7) },
      { label: "Registration year", value: String(1972 + (seed % 52)) },
      { label: "Mutation entries", value: String(1 + (seed % 5)) },
      { label: "Encumbrance noted", value: seed % 3 === 0 ? "Yes — charge recorded" : "None found" },
    ],
    checks: [
      { label: "Page legibility", ok: confidence > 76 },
      { label: "Survey number format", ok: seed % 7 !== 0 },
      { label: "Owner name consistency", ok: seed % 5 !== 0 },
      { label: "Area matches map sheet", ok: seed % 4 !== 0 },
      { label: "Seal and signature present", ok: seed % 6 !== 0 },
    ],
  };
};

const stageFor = (batch) => {
  const elapsed = Date.now() - batch.createdAt;
  const step = Math.floor(elapsed / STAGE_MS);
  // 5 == every stage finished.
  return Math.min(step, 5);
};

const serialise = (batch) => {
  const stage = stageFor(batch);
  const stages = [
    { key: "received", label: "Batch received" },
    { key: "ocr", label: "OCR extraction" },
    { key: "ai", label: "AI verification" },
    { key: "human", label: "Human review" },
    { key: "mapped", label: "GIS mapping" },
  ].map((s, i) => ({
    ...s,
    state: i < stage ? "done" : i === stage ? "active" : "pending",
  }));

  const complete = stage >= 5;
  return {
    id: batch.id,
    reference: batch.reference,
    createdAt: batch.createdAt,
    complete,
    status: complete ? "Verification complete" : "Verification in progress",
    stages,
    documents: complete || stage >= 1 ? batch.documents : [],
    totals: {
      documents: batch.documents.length,
      pages: batch.documents.reduce((n, d) => n + d.pages, 0),
      verified: batch.documents.filter((d) => d.status === "Verified").length,
      flagged: batch.documents.filter((d) => d.status !== "Verified").length,
      confidence: Math.round(
        batch.documents.reduce((n, d) => n + d.confidence, 0) / Math.max(1, batch.documents.length)
      ),
    },
  };
};

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const sendJson = (response, code, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    ...BASE_HEADERS,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const sendText = (response, code, message, extra = {}) => {
  response.writeHead(code, {
    ...BASE_HEADERS,
    ...extra,
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(message + "\n");
};

const sendHtml = (response, file, method) => {
  response.writeHead(200, {
    ...BASE_HEADERS,
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file);
  // Without this, a read error after headers are sent takes the process down.
  stream.on("error", () => response.destroy());
  stream.pipe(response);
};

// Wrong method on a path that does exist should say so, not 404.
const methodNotAllowed = (response, allow) =>
  sendText(response, 405, "Method not allowed", { allow: allow.join(", ") });

const handle = (request, response) => {
  const method = request.method || "GET";
  const path = (request.url || "/").split("?")[0];
  const isRead = method === "GET" || method === "HEAD";

  if (path === "/health") {
    if (!isRead) return methodNotAllowed(response, ["GET", "HEAD"]);
    return sendJson(response, 200, { status: "ok", batches: batches.size });
  }

  /* ---- Create a submission batch ---- */
  if (path === "/api/submissions") {
    if (method !== "POST") return methodNotAllowed(response, ["POST"]);

    let raw = "";
    let tooBig = false;

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        tooBig = true;
        request.destroy();
      }
    });

    request.on("end", () => {
      if (tooBig || response.writableEnded) return;
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(response, 400, { error: "Invalid JSON body." });
        return;
      }

      const incoming = Array.isArray(payload.files) ? payload.files.slice(0, 40) : [];
      const files = incoming
        .filter((f) => f && typeof f.name === "string")
        .map((f) => ({ name: String(f.name).slice(0, 160), size: Number(f.size) || 0 }));

      if (!files.length) {
        sendJson(response, 400, { error: "No files described in the request." });
        return;
      }

      const id = randomUUID();
      sequence += 1;
      const batch = {
        id,
        reference: "LRD-" + new Date().getFullYear() + "-" + String(sequence).padStart(4, "0"),
        createdAt: Date.now(),
        documents: files.map(buildRecord),
      };

      batches.set(id, batch);
      // Keep the store bounded.
      if (batches.size > MAX_BATCHES) {
        batches.delete(batches.keys().next().value);
      }

      sendJson(response, 201, { id, reference: batch.reference });
    });
    return;
  }

  /* ---- Read a submission batch ---- */
  if (path.startsWith("/api/submissions/")) {
    if (!isRead) return methodNotAllowed(response, ["GET", "HEAD"]);

    const id = decodeURIComponent(path.slice("/api/submissions/".length));
    const batch = batches.get(id);
    if (!batch) {
      return sendJson(response, 404, { error: "Batch not found. It may have expired." });
    }
    return sendJson(response, 200, serialise(batch));
  }

  // Anything else under /api should answer in JSON, not plain text.
  if (path.startsWith("/api/")) {
    return sendJson(response, 404, { error: "Unknown endpoint: " + path });
  }

  /* ---- Static assets ---- */
  if (path.startsWith("/assets/")) {
    if (!isRead) return methodNotAllowed(response, ["GET", "HEAD"]);

    // basename() strips any directory traversal before touching the filesystem.
    const file = join(assetsDir, basename(decodeURIComponent(path)));
    const type = mimeTypes[extname(file).toLowerCase()];

    if (type && existsSync(file) && statSync(file).isFile()) {
      const { size, mtimeMs } = statSync(file);
      const etag = '"' + size.toString(16) + "-" + Math.round(mtimeMs).toString(16) + '"';

      // Let the browser skip the download when nothing changed.
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ...BASE_HEADERS, etag });
        return response.end();
      }

      response.writeHead(200, {
        ...BASE_HEADERS,
        "cache-control": "public, max-age=3600",
        "content-type": type,
        "content-length": size,
        etag,
      });

      if (method === "HEAD") return response.end();

      const stream = createReadStream(file);
      stream.on("error", () => response.destroy());
      return stream.pipe(response);
    }
  }

  /* ---- Pages ---- */
  if (path === "/verification" || path === "/verification.html") {
    if (!isRead) return methodNotAllowed(response, ["GET", "HEAD"]);
    return sendHtml(response, verificationPath, method);
  }

  if (path === "/" || path === "/index.html") {
    if (!isRead) return methodNotAllowed(response, ["GET", "HEAD"]);
    return sendHtml(response, indexPath, method);
  }

  return sendText(response, 404, "Not found");
};

const server = createServer((request, response) => {
  const started = Date.now();

  response.on("finish", () => {
    console.log(
      `${request.method} ${request.url} -> ${response.statusCode} (${Date.now() - started}ms)`
    );
  });

  // A throw inside a handler would otherwise take the whole process down.
  try {
    handle(request, response);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Internal server error." });
    } else {
      response.destroy();
    }
  }
});

// Client aborts (navigating away mid-poll) must not be fatal.
server.on("clientError", (error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", (error) => {
  console.error("Server error:", error);
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`NewSample3017 listening on http://0.0.0.0:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
