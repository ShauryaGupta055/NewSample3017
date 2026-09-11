# NewSample3017

Land record digitization landing page with a document submission and verification flow.
Dependency-free: plain Node built-ins, one static HTML page per route, no build step.

## Run with Docker

```sh
docker compose -f docker-compose.alloy.yaml up -d
```

The application listens on port `3000`. Alloy proxies its preview from `http://localhost:8080`.

Check container health with:

```sh
docker compose -f docker-compose.alloy.yaml ps
```

Editing `index.html`, `verification.html` or anything in `assets/` takes effect on the next request.
Changes to `server.js` need a restart:

```sh
docker compose -f docker-compose.alloy.yaml restart site
```

## Routes

| Route                      | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `GET /`                    | Landing page (`index.html`)                                  |
| `GET /verification?batch=` | Verification status page (`verification.html`)               |
| `GET /assets/*`            | Images and illustrations                                     |
| `GET /health`              | Health probe used by the compose healthcheck                 |
| `POST /api/submissions`    | Create a submission batch, returns `{ id, reference }`       |
| `GET /api/submissions/:id` | Batch status, pipeline stages, per-document extracted fields |

## Submission flow

1. The upload panel on the landing page accepts files by drag-and-drop or file picker,
   enforcing a 25 MB per-file limit client side.
2. Submitting posts the file names and sizes as JSON to `POST /api/submissions`.
3. The browser is redirected to `/verification?batch=<id>`.
4. That page polls `GET /api/submissions/:id` every 1.6s, advancing a five-stage pipeline
   (received, OCR, AI verification, human review, GIS mapping) and rendering the extracted
   fields, confidence score and validation checks for each document.

### Prototype limitations

- **No OCR engine and no database.** Field values (survey number, khata, village, tenure
  class, and so on) are generated deterministically from each file name and size, so the same
  file always produces the same record. They are not read from the document contents. The
  verification page states this on the page itself.
- **File contents are never uploaded.** Only names and sizes are sent, so nothing is stored
  on disk.
- **Batches are held in memory** (capped at 200) and are cleared when the container restarts,
  at which point a batch URL returns the "could not be found" state.
- Pipeline stages advance on a timer (~2.6s per stage) rather than reflecting real work.
