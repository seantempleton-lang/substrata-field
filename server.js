const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "3002", 10);
const HOST = process.env.HOST || "0.0.0.0";
const APP_DIR = path.join(__dirname, "substrata-field");
const DATA_PATH = process.env.SUBSTRATA_API_DATA || path.join(__dirname, "api-data.json");
const SHOULD_SEED = String(process.env.SUBSTRATA_SEED_DB || "true").toLowerCase() !== "false";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

let pool = null;
let dbDisabledReason = null;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hasDatabaseConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER)
  );
}

function getPool() {
  if (!hasDatabaseConfig() || dbDisabledReason) return null;
  if (pool) return pool;

  const { Pool } = require("pg");
  const config = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
      }
    : {
        host: process.env.PGHOST,
        port: parseInt(process.env.PGPORT || "5432", 10),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
      };

  pool = new Pool(config);
  return pool;
}

function readApiData() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

async function ensureDatabaseSchema() {
  const db = getPool();
  if (!db) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      proj_id TEXT PRIMARY KEY,
      proj_name TEXT NOT NULL,
      location TEXT,
      client TEXT,
      engineer TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS points (
      proj_id TEXT NOT NULL REFERENCES projects(proj_id) ON DELETE CASCADE,
      point_id TEXT NOT NULL,
      type TEXT,
      hole_depth DOUBLE PRECISION,
      location TEXT,
      PRIMARY KEY (proj_id, point_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS job_records (
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      proj_id TEXT NOT NULL REFERENCES projects(proj_id) ON DELETE CASCADE,
      point_id TEXT NOT NULL,
      job_key TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL,
      PRIMARY KEY (record_type, record_id)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_job_records_job
    ON job_records (proj_id, point_id, record_type, created_at);
  `);
}

async function seedDatabaseIfNeeded() {
  const db = getPool();
  if (!db || !SHOULD_SEED) return;

  const existing = await db.query("SELECT COUNT(*)::int AS count FROM projects");
  if (existing.rows[0]?.count > 0) return;

  const data = readApiData();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const project of data.projects) {
      await client.query(
        `INSERT INTO projects (proj_id, proj_name, location, client, engineer)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (proj_id) DO UPDATE
         SET proj_name = EXCLUDED.proj_name,
             location = EXCLUDED.location,
             client = EXCLUDED.client,
             engineer = EXCLUDED.engineer`,
        [
          project.PROJ_ID,
          project.PROJ_NAME,
          project.Location || null,
          project.Client || null,
          project.Engineer || null,
        ]
      );
    }

    for (const [projId, points] of Object.entries(data.points || {})) {
      for (const point of points) {
        await client.query(
          `INSERT INTO points (proj_id, point_id, type, hole_depth, location)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (proj_id, point_id) DO UPDATE
           SET type = EXCLUDED.type,
               hole_depth = EXCLUDED.hole_depth,
               location = EXCLUDED.location`,
          [
            projId,
            point.POINT_ID,
            point.Type || null,
            point.HoleDepth ?? null,
            point.Location || null,
          ]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getProjects() {
  const db = getPool();
  if (!db) return readApiData().projects;

  const result = await db.query(`
    SELECT
      proj_id AS "PROJ_ID",
      proj_name AS "PROJ_NAME",
      location AS "Location",
      client AS "Client",
      engineer AS "Engineer"
    FROM projects
    ORDER BY proj_id;
  `);
  return result.rows;
}

async function getPoints(projId) {
  const db = getPool();
  if (!db) return readApiData().points?.[projId] || [];

  const result = await db.query(
    `SELECT
       point_id AS "POINT_ID",
       type AS "Type",
       hole_depth AS "HoleDepth",
       location AS "Location"
     FROM points
     WHERE proj_id = $1
     ORDER BY point_id`,
    [projId]
  );
  return result.rows;
}

async function getHealth() {
  const db = getPool();
  if (!db) {
    const data = readApiData();
    return {
      ok: true,
      backend: "file",
      projects: data.projects.length,
      databaseConfigured: hasDatabaseConfig(),
      databaseError: dbDisabledReason,
    };
  }

  const result = await db.query("SELECT COUNT(*)::int AS count FROM projects");
  return {
    ok: true,
    backend: "postgres",
    projects: result.rows[0]?.count || 0,
    databaseConfigured: true,
    databaseError: null,
  };
}

async function syncPoints(points) {
  const db = getPool();
  if (!db) throw createHttpError(503, "Sync requires PostgreSQL configuration");
  if (!Array.isArray(points)) throw createHttpError(400, "points must be an array");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const saved = [];
    for (const point of points) {
      if (!point?.PROJ_ID || !point?.POINT_ID) continue;
      await client.query(
        `INSERT INTO points (proj_id, point_id, type, hole_depth, location)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (proj_id, point_id) DO UPDATE
         SET type = EXCLUDED.type,
             hole_depth = EXCLUDED.hole_depth,
             location = EXCLUDED.location`,
        [
          point.PROJ_ID,
          point.POINT_ID,
          point.Type || null,
          point.HoleDepth ?? null,
          point.Location || null,
        ]
      );
      saved.push(`${point.PROJ_ID}:${point.POINT_ID}`);
    }
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncRecords(records) {
  const db = getPool();
  if (!db) throw createHttpError(503, "Sync requires PostgreSQL configuration");
  if (!Array.isArray(records)) throw createHttpError(400, "records must be an array");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const saved = [];
    for (const item of records) {
      const recordType = item?.record_type;
      const record = item?.record;
      if (!recordType || !record?.id || !record?.PROJ_ID || !record?.POINT_ID) continue;

      await client.query(
        `INSERT INTO job_records (
           record_type, record_id, proj_id, point_id, job_key, created_at, updated_at, payload
         )
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7::jsonb)
         ON CONFLICT (record_type, record_id) DO UPDATE
         SET proj_id = EXCLUDED.proj_id,
             point_id = EXCLUDED.point_id,
             job_key = EXCLUDED.job_key,
             created_at = EXCLUDED.created_at,
             updated_at = NOW(),
             payload = EXCLUDED.payload`,
        [
          recordType,
          record.id,
          record.PROJ_ID,
          record.POINT_ID,
          record.job_key || `${record.PROJ_ID}_${record.POINT_ID}`,
          record.created_at || null,
          JSON.stringify({ ...record, sync_status: "synced" }),
        ]
      );
      saved.push(`${recordType}:${record.id}`);
    }
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getSyncedRecords(projId, pointId) {
  const db = getPool();
  if (!db) return [];

  const result = await db.query(
    `SELECT record_type, payload
     FROM job_records
     WHERE proj_id = $1 AND point_id = $2
     ORDER BY created_at NULLS LAST, record_type, record_id`,
    [projId, pointId]
  );

  return result.rows.map(row => ({
    record_type: row.record_type,
    record: { ...row.payload, sync_status: "synced" },
  }));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(createHttpError(413, "Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(createHttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
  };

  if (path.basename(filePath) === "sw.js" || path.basename(filePath) === "index.html") {
    headers["Cache-Control"] = "no-cache";
  } else if ([".js", ".json", ".png", ".svg", ".ico", ".css"].includes(ext)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }

  const stream = fs.createReadStream(filePath);
  stream.on("open", () => res.writeHead(200, headers));
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  });
  stream.pipe(res);
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(APP_DIR, safePath);
  const hasExtension = path.extname(safePath) !== "";

  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (hasExtension) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    filePath = path.join(APP_DIR, "index.html");
  }

  sendFile(res, filePath);
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    sendJson(res, 200, await getHealth());
    return;
  }

  if (url.pathname === "/api/projects") {
    sendJson(res, 200, await getProjects());
    return;
  }

  if (url.pathname === "/api/points") {
    const projId = url.searchParams.get("proj_id");
    if (!projId) {
      sendJson(res, 400, { error: "proj_id is required" });
      return;
    }
    sendJson(res, 200, await getPoints(projId));
    return;
  }

  if (url.pathname === "/api/sync/points" && req.method === "POST") {
    const body = await readRequestBody(req);
    const saved = await syncPoints(body.points || []);
    sendJson(res, 200, { ok: true, saved });
    return;
  }

  if (url.pathname === "/api/sync/records" && req.method === "GET") {
    const projId = url.searchParams.get("proj_id");
    const pointId = url.searchParams.get("point_id");
    if (!projId || !pointId) {
      sendJson(res, 400, { error: "proj_id and point_id are required" });
      return;
    }
    sendJson(res, 200, { ok: true, records: await getSyncedRecords(projId, pointId) });
    return;
  }

  if (url.pathname === "/api/sync/records" && req.method === "POST") {
    const body = await readRequestBody(req);
    const saved = await syncRecords(body.records || []);
    sendJson(res, 200, { ok: true, saved });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      if (!["GET", "POST"].includes(req.method)) {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    serveStatic(res, url.pathname);
  } catch (error) {
    if (error?.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

async function start() {
  if (hasDatabaseConfig()) {
    try {
      await ensureDatabaseSchema();
      await seedDatabaseIfNeeded();
      dbDisabledReason = null;
    } catch (error) {
      dbDisabledReason = error?.message || "Database unavailable";
      console.error("Database unavailable, starting in file-backed mode.", error);
      if (pool) {
        try {
          await pool.end();
        } catch (endError) {
          console.error("Failed to close database pool cleanly.", endError);
        }
      }
      pool = null;
    }
  }

  server.listen(PORT, HOST, () => {
    console.log(`SubStrata Field listening on http://${HOST}:${PORT}`);
  });
}
server.on("error", error => {
  console.error("Failed to start server", error);
  process.exit(1);
});

start().catch(error => {
  console.error("Failed during startup", error);
  process.exit(1);
});

module.exports = server;
