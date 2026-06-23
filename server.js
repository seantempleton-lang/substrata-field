const http = require("http");
const fs = require("fs");
const path = require("path");
const { createHash, randomBytes, scryptSync, timingSafeEqual } = require("crypto");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const APP_DIR = path.join(__dirname, "substrata-field");
const DATA_PATH = process.env.SUBSTRATA_API_DATA || path.join(__dirname, "api-data.json");
const SHOULD_SEED_DEMO_DATA = String(process.env.SUBSTRATA_SEED_DEMO_DATA || "false").toLowerCase() === "true";
const SHOULD_SEED_AUTH = String(process.env.SUBSTRATA_SEED_AUTH || "true").toLowerCase() !== "false";
const SESSION_COOKIE_NAME = "substrata_session";
const SESSION_DURATION_DAYS = 30;
const APP_ROLE_ORDER = ["FieldUser", "Maintenance", "Supervisor", "Administrator", "SuperUser"];
const CORE_GS_ENABLED = String(process.env.CORE_GS_ENABLED || "false").toLowerCase() === "true";
const CORE_GS_CLNT_ID = process.env.CORE_GS_CLNT_ID || "Geotechnical";
const AUTH_SEED_USERS = [
  {
    employeeCode: "EMP-001",
    fullName: "Sean Templeton",
    initials: "ST",
    roleTitle: "Lead Geotech",
    division: "Geotech",
    region: "South",
    email: "sean@example.com",
    loginUsername: "SeanTempleton",
    loginEmail: "sean@example.com",
    appRole: "SuperUser",
    passwordHash: "scrypt$3178da955ccb5d7e8edead16b3aeb8ed$4765c4939153ad5b736d0f4f1b9f7e1367b45d021f040829c82298b4f811093cea24b0acf22da1917344c9d75b82b5e2ddef69ffd3162f0767c24d22fbe958aa",
  },
  {
    employeeCode: "EMP-004",
    fullName: "Tracey Flatman",
    initials: "TF",
    roleTitle: "Administrator",
    division: "Operations",
    region: "South",
    email: "tracey.flatman@drilling.co.nz",
    loginUsername: "TraceyFlatman",
    loginEmail: "tracey.flatman@drilling.co.nz",
    appRole: "Administrator",
    passwordHash: "scrypt$f5e65d0eb31b2accc16412ec634ff592$a3b426c416cd9b2722ce4ac608e1bbf8d40965b2797921a537687918360ca7c25bd2941af7581d5a2796254b8d69e7bbda3d6b3156c675a2736b3f66001f5f61",
  },
  {
    employeeCode: "EMP-006",
    fullName: "Tom Lubbe",
    initials: "TL",
    roleTitle: "Supervisor",
    division: "Geotech",
    region: "South",
    email: "tom.lubbe@drilling.co.nz",
    loginUsername: "TomLubbe",
    loginEmail: "tom.lubbe@drilling.co.nz",
    appRole: "Supervisor",
    passwordHash: "scrypt$b187ab906b1f7668bb10c78065a48631$c28ecfe9362f9f8004dc7f069add7391c8d05408d172493a6930f4305f2dcaf6caf8459fd7c7f84a7161402a992303d3a4d1f966fb5404d03fb509b0aa7d7991",
  },
  {
    employeeCode: "EMP-009",
    fullName: "Greg Cossar",
    initials: "GC",
    roleTitle: "Field Technician",
    division: "Geotech",
    region: "South",
    email: "greg.cossar@drilling.co.nz",
    loginUsername: "GregCossar",
    loginEmail: "greg.cossar@drilling.co.nz",
    appRole: "FieldUser",
    passwordHash: "scrypt$21a1f6d5036842a2e5e27ff5e0998904$076b3ba07d67c1ec924348073341f34f942d659c01b397d899e4578f497051f0d1450a1dbdc92f35bb6e3d0f003eb63f5d12c56737cc5de71bd2149af6f1548b",
  },
  {
    employeeCode: "EMP-010",
    fullName: "Rahul Negi",
    initials: "RN",
    roleTitle: "Field Technician",
    division: "Geotech",
    region: "South",
    email: "rahulnegi@drilling.co.nz",
    loginUsername: "RahulNegi",
    loginEmail: "rahulnegi@drilling.co.nz",
    appRole: "FieldUser",
    passwordHash: "scrypt$34c10e38ab1c21c1416a827e6eafc13b$e23188bf3dd1f57ee39e92db52c4f9f85444d41e939f34d19a2ec59d18f56f43732f0eaf94ebbc9ff6780f364a61cc77382785e19c924e5d8f82e34664df08d4",
  },
];

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
let coreGsPool = null;
let dbDisabledReason = null;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createCoreGsError(error, context = "CORE-GS request") {
  const sqlMessage = error?.originalError?.info?.message || error?.precedingErrors?.[0]?.message || error?.message;
  const message = sqlMessage ? `${context} failed: ${sqlMessage}` : `${context} failed`;
  const wrapped = createHttpError(502, message);
  wrapped.cause = error;
  return wrapped;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeLoginEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeLoginUsername(username) {
  return String(username || "").trim().replace(/[^A-Za-z0-9]/g, "");
}

function normalizeAppRole(role) {
  return APP_ROLE_ORDER.includes(role) ? role : "FieldUser";
}

function parseCookies(headerValue = "") {
  return headerValue
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return cookies;
      cookies[part.slice(0, separator)] = decodeURIComponent(part.slice(separator + 1));
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.secure) parts.push("Secure");
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const [algorithm, salt, hash] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const derived = scryptSync(String(password || ""), salt, Buffer.from(hash, "hex").length);
  const existing = Buffer.from(hash, "hex");
  return existing.length === derived.length && timingSafeEqual(existing, derived);
}

function getAuditContext(req) {
  return {
    ipAddress: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .split(",")[0]
      .trim() || null,
    userAgent: req.headers["user-agent"] || null,
  };
}

function normalizeUser(row) {
  if (!row) return null;
  const appRole = normalizeAppRole(row.app_role);
  return {
    dbId: row.user_id,
    id: row.employee_code,
    username: row.login_username,
    name: row.full_name,
    initials: row.initials,
    role: row.role_title,
    roleTitle: row.role_title,
    appRole,
    appRoleRank: APP_ROLE_ORDER.indexOf(appRole),
    division: row.division,
    region: row.region,
    email: row.email,
    phone: row.phone,
  };
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

function hasCoreGsConfig() {
  return Boolean(
    process.env.CORE_GS_HOST &&
    process.env.CORE_GS_DATABASE &&
    process.env.CORE_GS_USER &&
    process.env.CORE_GS_PASSWORD
  );
}

async function getCoreGsPool() {
  if (!CORE_GS_ENABLED) {
    throw createHttpError(503, "CORE-GS bridge is disabled");
  }
  if (!hasCoreGsConfig()) {
    throw createHttpError(503, "CORE-GS connection is not configured");
  }
  if (coreGsPool) return coreGsPool;

  const sql = require("mssql");
  const port = process.env.CORE_GS_PORT ? parseInt(process.env.CORE_GS_PORT, 10) : undefined;
  const instanceName = process.env.CORE_GS_INSTANCE || undefined;
  coreGsPool = await new sql.ConnectionPool({
    server: process.env.CORE_GS_HOST,
    ...(port ? { port } : {}),
    database: process.env.CORE_GS_DATABASE,
    user: process.env.CORE_GS_USER,
    password: process.env.CORE_GS_PASSWORD,
    options: {
      ...(instanceName ? { instanceName } : {}),
      encrypt: String(process.env.CORE_GS_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate: String(process.env.CORE_GS_TRUST_SERVER_CERTIFICATE || "true").toLowerCase() !== "false",
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  }).connect();
  return coreGsPool;
}

async function testCoreGsConnection() {
  const pool = await getCoreGsPool();
  const result = await pool.request().query(`
    SELECT
      DB_NAME() AS database_name,
      @@SERVERNAME AS server_name,
      SERVERPROPERTY('MachineName') AS machine_name,
      SERVERPROPERTY('InstanceName') AS instance_name,
      SERVERPROPERTY('ProductVersion') AS product_version,
      SERVERPROPERTY('ProductLevel') AS product_level,
      SERVERPROPERTY('Edition') AS edition,
      SUSER_SNAME() AS login_name;
  `);
  const row = result.recordset?.[0] || {};
  return {
    ok: true,
    host: process.env.CORE_GS_HOST,
    instance: process.env.CORE_GS_INSTANCE || null,
    port: process.env.CORE_GS_PORT || null,
    database: row.database_name || process.env.CORE_GS_DATABASE,
    serverName: row.server_name || null,
    machineName: row.machine_name || null,
    instanceName: row.instance_name || null,
    productVersion: row.product_version || null,
    productLevel: row.product_level || null,
    edition: row.edition || null,
    loginName: row.login_name || process.env.CORE_GS_USER,
    clientId: CORE_GS_CLNT_ID,
  };
}

function readApiData() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

async function ensureDatabaseSchema() {
  const db = getPool();
  if (!db) return;

  await db.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

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
      remarks TEXT,
      status TEXT,
      rig TEXT,
      driller_lookup TEXT,
      grid TEXT,
      PRIMARY KEY (proj_id, point_id)
    );
  `);

  await db.query("ALTER TABLE points ADD COLUMN IF NOT EXISTS remarks TEXT;");
  await db.query("ALTER TABLE points ADD COLUMN IF NOT EXISTS status TEXT;");
  await db.query("ALTER TABLE points ADD COLUMN IF NOT EXISTS rig TEXT;");
  await db.query("ALTER TABLE points ADD COLUMN IF NOT EXISTS driller_lookup TEXT;");
  await db.query("ALTER TABLE points ADD COLUMN IF NOT EXISTS grid TEXT;");

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_code TEXT NOT NULL UNIQUE,
      login_username TEXT NOT NULL,
      full_name TEXT NOT NULL,
      initials TEXT NOT NULL,
      role_title TEXT NOT NULL,
      app_role TEXT NOT NULL DEFAULT 'FieldUser',
      division TEXT,
      region TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT app_users_app_role_check
        CHECK (app_role IN ('SuperUser', 'Administrator', 'Supervisor', 'Maintenance', 'FieldUser'))
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_login_username_lower
    ON app_users (LOWER(login_username));
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_auth_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
      login_email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      failed_login_count integer NOT NULL DEFAULT 0,
      last_failed_login_at TIMESTAMPTZ,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES app_auth_accounts(id) ON DELETE CASCADE,
      session_token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_app_sessions_active
    ON app_sessions (session_token_hash, expires_at)
    WHERE revoked_at IS NULL;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_auth_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      account_id uuid REFERENCES app_auth_accounts(id) ON DELETE SET NULL,
      user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
      session_id uuid REFERENCES app_sessions(id) ON DELETE SET NULL,
      login_identifier TEXT,
      ip_address TEXT,
      user_agent TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_app_auth_events_type_created_at
    ON app_auth_events (event_type, created_at DESC);
  `);
}

async function seedDatabaseIfNeeded() {
  const db = getPool();
  if (!db || !SHOULD_SEED_DEMO_DATA) return;

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

async function seedAuthIfNeeded() {
  const db = getPool();
  if (!db || !SHOULD_SEED_AUTH) return;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const user of AUTH_SEED_USERS) {
      const userResult = await client.query(
        `INSERT INTO app_users (
           employee_code, login_username, full_name, initials, role_title,
           app_role, division, region, email
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (employee_code) DO UPDATE
         SET login_username = EXCLUDED.login_username,
             full_name = EXCLUDED.full_name,
             initials = EXCLUDED.initials,
             role_title = EXCLUDED.role_title,
             app_role = EXCLUDED.app_role,
             division = EXCLUDED.division,
             region = EXCLUDED.region,
             email = EXCLUDED.email,
             updated_at = NOW()
         RETURNING id`,
        [
          user.employeeCode,
          user.loginUsername,
          user.fullName,
          user.initials,
          user.roleTitle,
          user.appRole,
          user.division,
          user.region,
          user.email,
        ]
      );

      await client.query(
        `INSERT INTO app_auth_accounts (user_id, login_email, password_hash, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id) DO UPDATE
         SET login_email = EXCLUDED.login_email,
             password_hash = EXCLUDED.password_hash,
             is_active = true,
             updated_at = NOW()`,
        [userResult.rows[0].id, user.loginEmail, user.passwordHash]
      );
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
  if (CORE_GS_ENABLED && hasCoreGsConfig()) return getCoreGsProjects();

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
  if (CORE_GS_ENABLED && hasCoreGsConfig()) return getCoreGsPoints(projId);

  const db = getPool();
  if (!db) return readApiData().points?.[projId] || [];

  const result = await db.query(
    `SELECT
       point_id AS "POINT_ID",
       type AS "Type",
       hole_depth AS "HoleDepth",
       location AS "Location",
       remarks AS "Remarks",
       status AS "Status",
       rig AS "Rig",
       driller_lookup AS "DrillerLookup",
       grid AS "Grid"
     FROM points
     WHERE proj_id = $1
     ORDER BY point_id`,
    [projId]
  );
  return result.rows;
}

async function getCoreGsProjects() {
  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .query(`
      SELECT
        PROJ_ID AS PROJ_ID,
        PROJ_NAME AS PROJ_NAME,
        Location AS Location,
        Client AS Client,
        Engineer AS Engineer
      FROM dbo.PROJECT
      WHERE CLNT_ID = @CLNT_ID
      ORDER BY PROJ_ID;
    `);
  return result.recordset || [];
}

async function getCoreGsPoints(projId) {
  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), projId)
    .query(`
      SELECT
        POINT_ID AS POINT_ID,
        Type AS Type,
        HoleDepth AS HoleDepth,
        Location AS Location,
        Remarks AS Remarks,
        StartDate AS StartDate,
        EndDate AS EndDate,
        LoggedBy AS LoggedBy,
        Driller AS Driller,
        DrillerLookup AS DrillerLookup,
        Rig AS Rig,
        Grid AS Grid,
        Status AS Status
      FROM dbo.POINT
      WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID
      ORDER BY COALESCE(Sort, 2147483647), POINT_ID;
    `);
  return result.recordset || [];
}

async function getHoleTypes() {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig()) {
    return [
      { VALUE: "RC", Description: "Rotary cored" },
      { VALUE: "RO", Description: "Rotary open hole" },
      { VALUE: "CP", Description: "Cable percussion (shell and auger)" },
      { VALUE: "SCP", Description: "Static cone penetrometer" },
      { VALUE: "TP", Description: "Trial pit/trench" },
      { VALUE: "WS", Description: "Window sampler" },
    ];
  }

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request().query(`
    SELECT VALUE AS VALUE, Description AS Description
    FROM dbo.LUT_HoleType
    WHERE VALUE IS NOT NULL AND LTRIM(RTRIM(VALUE)) <> ''
    ORDER BY COALESCE(Sort, 2147483647), VALUE;
  `);
  return result.recordset || [];
}

async function getPointFieldLookups() {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig()) {
    return {
      holeTypes: await getHoleTypes(),
      statuses: [],
      rigs: [],
      drillers: [],
      grids: [],
    };
  }

  const [holeTypes, statuses, rigs, drillers, grids] = await Promise.all([
    getCoreGsLookupValues({ table: "LUT_HoleType" }),
    getCoreGsLookupValues({ table: "LUT_HoleStatus" }),
    getCoreGsLookupValues({ table: "Rig" }),
    getCoreGsLookupValues({ table: "DrillerLookup" }),
    getCoreGsLookupValues({ table: "Grids" }),
  ]);

  return { holeTypes, statuses, rigs, drillers, grids };
}

function normalizeSqlIdentifier(value, fallback = "dbo") {
  const identifier = String(value || fallback).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw createHttpError(400, "Invalid SQL identifier");
  }
  return identifier;
}

function quoteSqlIdentifier(identifier) {
  return `[${normalizeSqlIdentifier(identifier).replace(/]/g, "]]")}]`;
}

function parseLimit(value, fallback = 100, max = 500) {
  const limit = parseInt(value || fallback, 10);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, max);
}

async function getCoreGsTables(search = "") {
  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request()
    .input("Search", sql.NVarChar(200), nullableText(search))
    .query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS row_count
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN sys.partitions p ON p.object_id = t.object_id
      WHERE @Search IS NULL
         OR t.name LIKE '%' + @Search + '%'
         OR s.name LIKE '%' + @Search + '%'
      GROUP BY s.name, t.name
      ORDER BY s.name, t.name;
    `);
  return result.recordset || [];
}

async function getCoreGsTableDetails({ schema = "dbo", table, sampleLimit = 0 }) {
  const sql = require("mssql");
  const schemaName = normalizeSqlIdentifier(schema);
  const tableName = normalizeSqlIdentifier(table, "");
  if (!tableName) throw createHttpError(400, "table is required");

  const pool = await getCoreGsPool();
  const objectResult = await pool.request()
    .input("SchemaName", sql.NVarChar(128), schemaName)
    .input("TableName", sql.NVarChar(128), tableName)
    .query(`
      SELECT t.object_id
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @SchemaName AND t.name = @TableName;
    `);
  const objectId = objectResult.recordset?.[0]?.object_id;
  if (!objectId) throw createHttpError(404, "CORE-GS table not found");

  const columnsResult = await pool.request()
    .input("ObjectId", sql.Int, objectId)
    .query(`
      SELECT
        c.column_id,
        c.name AS column_name,
        ty.name AS data_type,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        dc.definition AS default_definition,
        CASE WHEN pk.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_primary_key
      FROM sys.columns c
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints dc
        ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
      WHERE c.object_id = @ObjectId
      ORDER BY c.column_id;
    `);

  const foreignKeysResult = await pool.request()
    .input("ObjectId", sql.Int, objectId)
    .query(`
      SELECT
        fk.name AS foreign_key_name,
        pc.name AS column_name,
        rs.name AS referenced_schema,
        rt.name AS referenced_table,
        rc.name AS referenced_column
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fk.parent_object_id = @ObjectId
      ORDER BY fk.name, fkc.constraint_column_id;
    `);

  const indexesResult = await pool.request()
    .input("ObjectId", sql.Int, objectId)
    .query(`
      SELECT
        i.name AS index_name,
        i.type_desc,
        i.is_unique,
        i.is_primary_key,
        i.is_unique_constraint,
        ic.key_ordinal,
        c.name AS column_name,
        ic.is_included_column
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.object_id = @ObjectId AND i.name IS NOT NULL
      ORDER BY i.name, ic.key_ordinal, ic.index_column_id;
    `);

  let sample = [];
  const limit = parseLimit(sampleLimit, 0, 100);
  if (limit > 0) {
    const sampleResult = await pool.request().query(`
      SELECT TOP (${limit}) *
      FROM ${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(tableName)};
    `);
    sample = sampleResult.recordset || [];
  }

  return {
    schema: schemaName,
    table: tableName,
    columns: columnsResult.recordset || [],
    foreignKeys: foreignKeysResult.recordset || [],
    indexes: indexesResult.recordset || [],
    sample,
  };
}

async function getCoreGsLookupTables() {
  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request().query(`
    SELECT
      s.name AS schema_name,
      t.name AS table_name,
      MAX(CASE WHEN c.name = 'VALUE' THEN 1 ELSE 0 END) AS has_value,
      MAX(CASE WHEN c.name = 'Description' THEN 1 ELSE 0 END) AS has_description,
      MAX(CASE WHEN c.name = 'Sort' THEN 1 ELSE 0 END) AS has_sort
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.columns c ON c.object_id = t.object_id
    GROUP BY s.name, t.name
    HAVING t.name LIKE 'LUT[_]%'
       OR MAX(CASE WHEN c.name = 'VALUE' THEN 1 ELSE 0 END) = 1
    ORDER BY s.name, t.name;
  `);
  return result.recordset || [];
}

async function getCoreGsLookupValues({ schema = "dbo", table, limit = 200 }) {
  const sql = require("mssql");
  const schemaName = normalizeSqlIdentifier(schema);
  const tableName = normalizeSqlIdentifier(table, "");
  if (!tableName) throw createHttpError(400, "table is required");

  const pool = await getCoreGsPool();
  const metadata = await pool.request()
    .input("SchemaName", sql.NVarChar(128), schemaName)
    .input("TableName", sql.NVarChar(128), tableName)
    .query(`
      SELECT
        MAX(CASE WHEN c.name = 'VALUE' THEN 1 ELSE 0 END) AS has_value,
        MAX(CASE WHEN c.name = 'Description' THEN 1 ELSE 0 END) AS has_description,
        MAX(CASE WHEN c.name = 'Label' THEN 1 ELSE 0 END) AS has_label,
        MAX(CASE WHEN c.name = 'Sort' THEN 1 ELSE 0 END) AS has_sort,
        MAX(CASE WHEN c.name = 'CLNT_ID' THEN 1 ELSE 0 END) AS has_clnt_id
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id
      WHERE s.name = @SchemaName AND t.name = @TableName;
    `);
  const row = metadata.recordset?.[0] || {};
  if (!row.has_value) throw createHttpError(400, "Table is not a VALUE lookup table");

  const safeLimit = parseLimit(limit, 200, 1000);
  const columns = [
    "VALUE",
    row.has_description
      ? "Description"
      : row.has_label
        ? "Label AS Description"
        : "CAST(NULL AS nvarchar(4000)) AS Description",
    row.has_sort ? "Sort" : "CAST(NULL AS int) AS Sort",
  ].join(", ");
  const orderBy = row.has_sort ? "ORDER BY COALESCE(Sort, 2147483647), VALUE" : "ORDER BY VALUE";
  const whereClient = row.has_clnt_id ? "AND CLNT_ID = @CLNT_ID" : "";
  const result = await pool.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .query(`
    SELECT TOP (${safeLimit}) ${columns}
    FROM ${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(tableName)}
    WHERE VALUE IS NOT NULL
      ${whereClient}
    ${orderBy};
  `);
  return result.recordset || [];
}

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function getFieldProjectPointRows() {
  const projects = await getProjects();
  const pointsByProject = await Promise.all(projects.map(async project => {
    const points = await getPoints(project.PROJ_ID);
    return points.map(point => ({
      ...point,
      PROJ_ID: project.PROJ_ID,
    }));
  }));

  return {
    projects: projects.map(project => ({
      PROJ_ID: nullableText(project.PROJ_ID),
      PROJ_NAME: nullableText(project.PROJ_NAME),
      Location: nullableText(project.Location),
      Client: nullableText(project.Client),
      Engineer: nullableText(project.Engineer),
    })).filter(project => project.PROJ_ID && project.PROJ_NAME),
    points: pointsByProject.flat().map(point => ({
      PROJ_ID: nullableText(point.PROJ_ID),
      POINT_ID: nullableText(point.POINT_ID),
      FieldType: nullableText(point.Type),
      Type: nullableText(point.Type),
      HoleDepth: nullableNumber(point.HoleDepth),
      Location: nullableText(point.Location),
    })).filter(point => point.PROJ_ID && point.POINT_ID),
  };
}

async function getCoreGsProjectPointPreview() {
  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const { projects, points } = await getFieldProjectPointRows();
  const preview = {
    ok: true,
    dryRun: true,
    clientId: CORE_GS_CLNT_ID,
    projects: { total: projects.length, insert: 0, update: 0, unmatchedClient: 0 },
    points: { total: points.length, insert: 0, update: 0, missingProject: 0, unmatchedType: 0 },
  };

  for (const project of projects) {
    const result = await pool.request()
      .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
      .input("PROJ_ID", sql.NVarChar(40), project.PROJ_ID)
      .input("Client", sql.NVarChar(200), project.Client)
      .query(`
        SELECT
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.PROJECT WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID
          ) THEN 1 ELSE 0 END AS project_found,
          CASE WHEN @Client IS NULL OR EXISTS (
            SELECT 1 FROM dbo.Clients WHERE CLNT_ID = @CLNT_ID AND CLIENT_ID = @Client
          ) THEN 1 ELSE 0 END AS client_found;
      `);
    const row = result.recordset[0] || {};
    if (row.project_found) preview.projects.update += 1;
    else preview.projects.insert += 1;
    if (!row.client_found) preview.projects.unmatchedClient += 1;
  }

  for (const point of points) {
    const result = await pool.request()
      .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
      .input("PROJ_ID", sql.NVarChar(40), point.PROJ_ID)
      .input("POINT_ID", sql.NVarChar(40), point.POINT_ID)
      .input("Type", sql.VarChar(20), point.Type)
      .input("FieldType", sql.VarChar(20), point.FieldType)
      .query(`
        SELECT
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.PROJECT WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID
          ) THEN 1 ELSE 0 END AS project_found,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.POINT
            WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID AND POINT_ID = @POINT_ID
          ) THEN 1 ELSE 0 END AS point_found,
          CASE WHEN @Type IS NULL OR EXISTS (
            SELECT 1 FROM dbo.LUT_HoleType WHERE VALUE = @Type
          ) THEN 1 ELSE 0 END AS type_found,
          CASE WHEN @FieldType IS NOT NULL AND @Type IS NULL
          THEN 1 ELSE 0 END AS type_unmapped;
      `);
    const row = result.recordset[0] || {};
    if (!row.project_found && !projects.some(project => project.PROJ_ID === point.PROJ_ID)) {
      preview.points.missingProject += 1;
    }
    if (row.point_found) preview.points.update += 1;
    else preview.points.insert += 1;
    if (!row.type_found || row.type_unmapped) preview.points.unmatchedType += 1;
  }

  return preview;
}

async function upsertCoreGsProject(transaction, project) {
  const sql = require("mssql");
  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), project.PROJ_ID)
    .input("PROJ_NAME", sql.VarChar(sql.MAX), project.PROJ_NAME)
    .input("Location", sql.VarChar(sql.MAX), project.Location)
    .input("Client", sql.NVarChar(200), project.Client)
    .input("Engineer", sql.VarChar(sql.MAX), project.Engineer)
    .query(`
      IF EXISTS (
        SELECT 1 FROM dbo.PROJECT WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID
      )
      BEGIN
        UPDATE dbo.PROJECT
        SET PROJ_NAME = @PROJ_NAME,
            Location = @Location,
            Client = CASE
              WHEN @Client IS NULL THEN NULL
              WHEN EXISTS (
                SELECT 1 FROM dbo.Clients WHERE CLNT_ID = @CLNT_ID AND CLIENT_ID = @Client
              ) THEN @Client
              ELSE NULL
            END,
            Engineer = @Engineer
        WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID;
        SELECT CAST('update' AS varchar(10)) AS action;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.PROJECT (CLNT_ID, PROJ_ID, PROJ_NAME, Location, Client, Engineer)
        VALUES (
          @CLNT_ID,
          @PROJ_ID,
          @PROJ_NAME,
          @Location,
          CASE
            WHEN @Client IS NULL THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM dbo.Clients WHERE CLNT_ID = @CLNT_ID AND CLIENT_ID = @Client
            ) THEN @Client
            ELSE NULL
          END,
          @Engineer
        );
        SELECT CAST('insert' AS varchar(10)) AS action;
      END
    `);
  return result.recordset?.[0]?.action || "unknown";
}

async function upsertCoreGsPoint(transaction, point) {
  const sql = require("mssql");
  await validateCoreGsPoint(transaction, point);

  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), point.PROJ_ID)
    .input("POINT_ID", sql.NVarChar(40), point.POINT_ID)
    .input("HoleDepth", sql.Decimal(6, 2), point.HoleDepth)
    .input("Location", sql.VarChar(sql.MAX), point.Location)
    .input("Remarks", sql.VarChar(sql.MAX), point.Remarks)
    .input("Type", sql.VarChar(20), point.Type)
    .input("Status", sql.NVarChar(40), point.Status)
    .input("Rig", sql.NVarChar(40), point.Rig)
    .input("DrillerLookup", sql.NVarChar(60), point.DrillerLookup)
    .input("Grid", sql.NVarChar(40), point.Grid)
    .query(`
      IF EXISTS (
        SELECT 1 FROM dbo.POINT
        WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID AND POINT_ID = @POINT_ID
      )
      BEGIN
        UPDATE dbo.POINT
        SET HoleDepth = @HoleDepth,
            Location = @Location,
            Remarks = @Remarks,
            Type = @Type,
            Status = @Status,
            Rig = @Rig,
            DrillerLookup = @DrillerLookup,
            Grid = @Grid
        WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID AND POINT_ID = @POINT_ID;
        SELECT CAST('update' AS varchar(10)) AS action;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.POINT (
          CLNT_ID, PROJ_ID, POINT_ID, HoleDepth, Location, Remarks, Type, Status, Rig, DrillerLookup, Grid
        )
        VALUES (
          @CLNT_ID,
          @PROJ_ID,
          @POINT_ID,
          @HoleDepth,
          @Location,
          @Remarks,
          @Type,
          @Status,
          @Rig,
          @DrillerLookup,
          @Grid
        );
        SELECT CAST('insert' AS varchar(10)) AS action;
      END
    `);
  return result.recordset?.[0]?.action || "unknown";
}

async function validateCoreGsPoint(transaction, point) {
  const sql = require("mssql");
  if (!point.PROJ_ID || !point.POINT_ID) throw createHttpError(400, "PROJ_ID and POINT_ID are required");

  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), point.PROJ_ID)
    .input("Type", sql.VarChar(20), point.Type)
    .input("Status", sql.NVarChar(40), point.Status)
    .input("Rig", sql.NVarChar(40), point.Rig)
    .input("DrillerLookup", sql.NVarChar(60), point.DrillerLookup)
    .input("Grid", sql.NVarChar(40), point.Grid)
    .query(`
      SELECT
        CASE WHEN EXISTS (
          SELECT 1 FROM dbo.PROJECT WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID
        ) THEN 1 ELSE 0 END AS project_found,
        CASE WHEN @Type IS NULL OR EXISTS (
          SELECT 1 FROM dbo.LUT_HoleType WHERE VALUE = @Type
        ) THEN 1 ELSE 0 END AS type_found,
        CASE WHEN @Status IS NULL OR EXISTS (
          SELECT 1 FROM dbo.LUT_HoleStatus WHERE VALUE = @Status
        ) THEN 1 ELSE 0 END AS status_found,
        CASE WHEN @Rig IS NULL OR EXISTS (
          SELECT 1 FROM dbo.Rig WHERE CLNT_ID = @CLNT_ID AND VALUE = @Rig
        ) THEN 1 ELSE 0 END AS rig_found,
        CASE WHEN @DrillerLookup IS NULL OR EXISTS (
          SELECT 1 FROM dbo.DrillerLookup WHERE CLNT_ID = @CLNT_ID AND VALUE = @DrillerLookup
        ) THEN 1 ELSE 0 END AS driller_found,
        CASE WHEN @Grid IS NULL OR EXISTS (
          SELECT 1 FROM dbo.Grids WHERE CLNT_ID = @CLNT_ID AND VALUE = @Grid
        ) THEN 1 ELSE 0 END AS grid_found;
    `);

  const row = result.recordset?.[0] || {};
  if (!row.project_found) throw createHttpError(400, `Project ${point.PROJ_ID} does not exist in CORE-GS`);
  if (!row.type_found) throw createHttpError(400, `Invalid POINT.Type lookup value: ${point.Type}`);
  if (!row.status_found) throw createHttpError(400, `Invalid POINT.Status lookup value: ${point.Status}`);
  if (!row.rig_found) throw createHttpError(400, `Invalid POINT.Rig lookup value: ${point.Rig}`);
  if (!row.driller_found) throw createHttpError(400, `Invalid POINT.DrillerLookup value: ${point.DrillerLookup}`);
  if (!row.grid_found) throw createHttpError(400, `Invalid POINT.Grid lookup value: ${point.Grid}`);
}

async function syncCoreGsProjectsAndPoints({ dryRun = true } = {}) {
  if (dryRun) return getCoreGsProjectPointPreview();

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const { projects, points } = await getFieldProjectPointRows();
  const transaction = new sql.Transaction(pool);
  const summary = {
    ok: true,
    dryRun: false,
    clientId: CORE_GS_CLNT_ID,
    projects: { total: projects.length, insert: 0, update: 0 },
    points: { total: points.length, insert: 0, update: 0 },
  };

  await transaction.begin();
  try {
    for (const project of projects) {
      const action = await upsertCoreGsProject(transaction, project);
      if (action === "insert") summary.projects.insert += 1;
      if (action === "update") summary.projects.update += 1;
    }

    for (const point of points) {
      const action = await upsertCoreGsPoint(transaction, point);
      if (action === "insert") summary.points.insert += 1;
      if (action === "update") summary.points.update += 1;
    }

    await transaction.commit();
    return summary;
  } catch (error) {
    await transaction.rollback().catch(() => null);
    throw error;
  }
}

async function syncCoreGsPoints(points) {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig() || !points.length) return null;

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const transaction = new sql.Transaction(pool);
  const summary = { total: points.length, insert: 0, update: 0 };

  await transaction.begin();
  try {
    for (const point of points) {
      const action = await upsertCoreGsPoint(transaction, {
        PROJ_ID: nullableText(point.PROJ_ID),
        POINT_ID: nullableText(point.POINT_ID),
        Type: nullableText(point.Type),
        HoleDepth: nullableNumber(point.HoleDepth),
        Location: nullableText(point.Location),
        Remarks: nullableText(point.Remarks),
        Status: nullableText(point.Status),
        Rig: nullableText(point.Rig),
        DrillerLookup: nullableText(point.DrillerLookup),
        Grid: nullableText(point.Grid),
      });
      if (action === "insert") summary.insert += 1;
      if (action === "update") summary.update += 1;
    }
    await transaction.commit();
    return summary;
  } catch (error) {
    await transaction.rollback().catch(() => null);
    throw error;
  }
}

function normalizeGeologyRecord(record) {
  const top = nullableNumber(record.TOP ?? record.top);
  const base = nullableNumber(record.BASE ?? record.base);
  return {
    id: nullableText(record.id) || `geo_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    PROJ_ID: nullableText(record.PROJ_ID),
    POINT_ID: nullableText(record.POINT_ID),
    Type: nullableText(record.Type),
    top,
    base,
    description: nullableText(record.Description ?? record.description),
    remarks: nullableText(record.Remarks ?? record.remarks),
    MoistureCondition: nullableText(record.MoistureCondition ?? record.moisture_condition),
    mode: nullableText(record.mode) || "soil",
    material: nullableText(record.material),
    created_at: nullableText(record.created_at) || new Date().toISOString(),
  };
}

function normalizeLookupMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function resolveCoreGsMoistureCondition(transaction, moistureText) {
  const value = nullableText(moistureText);
  if (!value) return null;

  const sql = require("mssql");
  const normalized = normalizeLookupMatch(value);
  const result = await transaction.request()
    .input("Moisture", sql.NVarChar(200), normalized)
    .query(`
      SELECT TOP (1) TypeID
      FROM dbo.LUT_MoistureType
      WHERE LOWER(LTRIM(RTRIM(TypeID))) = @Moisture
         OR LOWER(LTRIM(RTRIM(COALESCE(Code, '')))) = @Moisture
         OR LOWER(LTRIM(RTRIM(COALESCE(Description, '')))) = @Moisture
      ORDER BY ID;
    `);

  return nullableText(result.recordset?.[0]?.TypeID);
}

async function validateCoreGsGeology(transaction, geology) {
  const sql = require("mssql");
  if (!geology.PROJ_ID || !geology.POINT_ID) throw createHttpError(400, "PROJ_ID and POINT_ID are required");
  if (geology.top === null || geology.base === null) throw createHttpError(400, "GEOLOGY TOP and BASE are required");
  if (geology.base <= geology.top) throw createHttpError(400, "GEOLOGY BASE must be greater than TOP");

  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), geology.PROJ_ID)
    .input("POINT_ID", sql.NVarChar(40), geology.POINT_ID)
    .query(`
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM dbo.POINT
        WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID AND POINT_ID = @POINT_ID
      ) THEN 1 ELSE 0 END AS point_found;
    `);

  if (!result.recordset?.[0]?.point_found) {
    throw createHttpError(400, `Point ${geology.PROJ_ID}/${geology.POINT_ID} does not exist in CORE-GS`);
  }
}

async function upsertCoreGsGeology(transaction, record) {
  const sql = require("mssql");
  const geology = normalizeGeologyRecord(record);
  await validateCoreGsGeology(transaction, geology);
  const moistureCondition = await resolveCoreGsMoistureCondition(transaction, geology.MoistureCondition);

  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), geology.PROJ_ID)
    .input("POINT_ID", sql.NVarChar(40), geology.POINT_ID)
    .input("TOP", sql.Decimal(5, 2), geology.top)
    .input("BASE", sql.Decimal(5, 2), geology.base)
    .input("Description", sql.VarChar(sql.MAX), geology.description)
    .input("Remarks", sql.VarChar(sql.MAX), geology.remarks)
    .input("MoistureCondition", sql.NVarChar(40), moistureCondition)
    .query(`
      IF EXISTS (
        SELECT 1 FROM dbo.GEOLOGY
        WHERE CLNT_ID = @CLNT_ID
          AND PROJ_ID = @PROJ_ID
          AND POINT_ID = @POINT_ID
          AND [TOP] = @TOP
          AND [BASE] = @BASE
      )
      BEGIN
        UPDATE dbo.GEOLOGY
        SET Description = @Description,
            Remarks = @Remarks,
            MoistureCondition = @MoistureCondition
        WHERE CLNT_ID = @CLNT_ID
          AND PROJ_ID = @PROJ_ID
          AND POINT_ID = @POINT_ID
          AND [TOP] = @TOP
          AND [BASE] = @BASE;
        SELECT CAST('update' AS varchar(10)) AS action;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.GEOLOGY (
          CLNT_ID, PROJ_ID, POINT_ID, [TOP], [BASE], Description, Remarks, MoistureCondition
        )
        VALUES (
          @CLNT_ID, @PROJ_ID, @POINT_ID, @TOP, @BASE, @Description, @Remarks, @MoistureCondition
        );
        SELECT CAST('insert' AS varchar(10)) AS action;
      END
    `);
  return result.recordset?.[0]?.action || "unknown";
}

async function syncCoreGsGeology(records) {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig() || !records.length) return null;

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const transaction = new sql.Transaction(pool);
  const summary = { total: records.length, insert: 0, update: 0 };

  await transaction.begin();
  try {
    for (const record of records) {
      const action = await upsertCoreGsGeology(transaction, record);
      if (action === "insert") summary.insert += 1;
      if (action === "update") summary.update += 1;
    }
    await transaction.commit();
    return summary;
  } catch (error) {
    await transaction.rollback().catch(() => null);
    throw error;
  }
}

async function getCoreGsGeologyRecords(projId, pointId) {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig()) return [];

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), projId)
    .input("POINT_ID", sql.NVarChar(40), pointId)
    .query(`
      SELECT
        PROJ_ID,
        POINT_ID,
        [TOP] AS top_depth,
        [BASE] AS base_depth,
        Description AS description,
        Remarks AS remarks,
        MoistureCondition AS MoistureCondition,
        Legend AS material
      FROM dbo.GEOLOGY
      WHERE CLNT_ID = @CLNT_ID
        AND PROJ_ID = @PROJ_ID
        AND POINT_ID = @POINT_ID
      ORDER BY [TOP], [BASE];
    `);

  return (result.recordset || []).map(row => ({
    record_type: "geology",
    record: {
      id: `geo_coregs_${row.PROJ_ID}_${row.POINT_ID}_${row.top_depth}_${row.base_depth}`,
      GEO_ID: null,
      PROJ_ID: nullableText(row.PROJ_ID),
      POINT_ID: nullableText(row.POINT_ID),
      mode: "soil",
      description: nullableText(row.description),
      top: nullableNumber(row.top_depth),
      base: nullableNumber(row.base_depth),
      material: nullableText(row.material),
      remarks: nullableText(row.remarks),
      MoistureCondition: nullableText(row.MoistureCondition),
      created_at: new Date().toISOString(),
      sync_status: "synced",
      source: "core-gs",
    },
  }));
}

function normalizeSptRecord(record) {
  const top = nullableNumber(record.TOP ?? record.top);
  return {
    id: nullableText(record.id) || `spt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    PROJ_ID: nullableText(record.PROJ_ID),
    POINT_ID: nullableText(record.POINT_ID),
    top,
    Base: nullableNumber(record.Base ?? record.base),
    nValue: nullableNumber(record.NValue ?? record.nValue),
    Blow1: nullableNumber(record.Blow1),
    Blow2: nullableNumber(record.Blow2),
    Blow3: nullableNumber(record.Blow3),
    Blow4: nullableNumber(record.Blow4),
    Blow5: nullableNumber(record.Blow5),
    Blow6: nullableNumber(record.Blow6),
    Incr1: nullableNumber(record.Incr1),
    Incr2: nullableNumber(record.Incr2),
    Incr3: nullableNumber(record.Incr3),
    Incr4: nullableNumber(record.Incr4),
    Incr5: nullableNumber(record.Incr5),
    Incr6: nullableNumber(record.Incr6),
    TotalBlowCount: nullableNumber(record.TotalBlowCount),
    TotalPenetration: nullableNumber(record.TotalPenetration),
    Standard: nullableText(record.Standard),
    Remarks: nullableText(record.Remarks ?? record.remarks),
    created_at: nullableText(record.created_at) || new Date().toISOString(),
  };
}

function parseSptSampleRecovery(remarks) {
  const text = nullableText(remarks);
  if (!text) return { SampleRecoveryMm: null, SampleRecoveryPct: null };
  const match = text.match(/sample\s+recovery:\s*([0-9]+(?:\.[0-9]+)?)\s*mm(?:\s*\(([0-9]+)%\))?/i);
  if (!match) return { SampleRecoveryMm: null, SampleRecoveryPct: null };
  const recoveryMm = nullableNumber(match[1]);
  const recoveryPct = match[2] != null
    ? nullableNumber(match[2])
    : (recoveryMm == null ? null : Math.round((recoveryMm / 450) * 100));
  return { SampleRecoveryMm: recoveryMm, SampleRecoveryPct: recoveryPct };
}

async function validateCoreGsSpt(transaction, spt) {
  const sql = require("mssql");
  if (!spt.PROJ_ID || !spt.POINT_ID) throw createHttpError(400, "PROJ_ID and POINT_ID are required");
  if (spt.top === null) throw createHttpError(400, "SPT TOP is required");

  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), spt.PROJ_ID)
    .input("POINT_ID", sql.NVarChar(40), spt.POINT_ID)
    .input("Type", sql.NVarChar(2), spt.Type)
    .query(`
      SELECT
        CASE WHEN EXISTS (
          SELECT 1
          FROM dbo.POINT
          WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID AND POINT_ID = @POINT_ID
        ) THEN 1 ELSE 0 END AS point_found,
        CASE WHEN @Type IS NULL OR EXISTS (
          SELECT 1 FROM dbo.LUT_SptType WHERE Value = @Type
        ) THEN 1 ELSE 0 END AS type_found;
    `);

  if (!result.recordset?.[0]?.point_found) {
    throw createHttpError(400, `Point ${spt.PROJ_ID}/${spt.POINT_ID} does not exist in CORE-GS`);
  }
  if (!result.recordset?.[0]?.type_found) {
    throw createHttpError(400, `Invalid SPT.Type lookup value: ${spt.Type}`);
  }
}

async function upsertCoreGsSpt(transaction, record) {
  const sql = require("mssql");
  const spt = normalizeSptRecord(record);
  await validateCoreGsSpt(transaction, spt);

  const result = await transaction.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), spt.PROJ_ID)
    .input("POINT_ID", sql.NVarChar(40), spt.POINT_ID)
    .input("Type", sql.NVarChar(2), spt.Type)
    .input("TOP", sql.Decimal(5, 2), spt.top)
    .input("Base", sql.Decimal(15, 6), spt.Base)
    .input("NValue", sql.Int, spt.nValue)
    .input("Blow1", sql.Int, spt.Blow1)
    .input("Blow2", sql.Int, spt.Blow2)
    .input("Blow3", sql.Int, spt.Blow3)
    .input("Blow4", sql.Int, spt.Blow4)
    .input("Blow5", sql.Int, spt.Blow5)
    .input("Blow6", sql.Int, spt.Blow6)
    .input("Incr1", sql.Decimal(3, 0), spt.Incr1)
    .input("Incr2", sql.Decimal(3, 0), spt.Incr2)
    .input("Incr3", sql.Decimal(3, 0), spt.Incr3)
    .input("Incr4", sql.Decimal(3, 0), spt.Incr4)
    .input("Incr5", sql.Decimal(3, 0), spt.Incr5)
    .input("Incr6", sql.Decimal(3, 0), spt.Incr6)
    .input("TotalBlowCount", sql.Int, spt.TotalBlowCount)
    .input("TotalPenetration", sql.Decimal(8, 0), spt.TotalPenetration)
    .input("Standard", sql.VarChar(20), spt.Standard)
    .input("Remarks", sql.VarChar(sql.MAX), spt.Remarks)
    .query(`
      IF EXISTS (
        SELECT 1 FROM dbo.SPT
        WHERE CLNT_ID = @CLNT_ID
          AND PROJ_ID = @PROJ_ID
          AND POINT_ID = @POINT_ID
          AND [TOP] = @TOP
      )
      BEGIN
        UPDATE dbo.SPT
        SET Base = @Base,
            Type = @Type,
            NValue = @NValue,
            Blow1 = @Blow1,
            Blow2 = @Blow2,
            Blow3 = @Blow3,
            Blow4 = @Blow4,
            Blow5 = @Blow5,
            Blow6 = @Blow6,
            Incr1 = @Incr1,
            Incr2 = @Incr2,
            Incr3 = @Incr3,
            Incr4 = @Incr4,
            Incr5 = @Incr5,
            Incr6 = @Incr6,
            TotalBlowCount = @TotalBlowCount,
            TotalPenetration = @TotalPenetration,
            Standard = @Standard,
            Remarks = @Remarks
        WHERE CLNT_ID = @CLNT_ID
          AND PROJ_ID = @PROJ_ID
          AND POINT_ID = @POINT_ID
          AND [TOP] = @TOP;
        SELECT CAST('update' AS varchar(10)) AS action;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.SPT (
          CLNT_ID, PROJ_ID, POINT_ID, [TOP], Base, Type, NValue,
          Blow1, Blow2, Blow3, Blow4, Blow5, Blow6,
          Incr1, Incr2, Incr3, Incr4, Incr5, Incr6,
          TotalBlowCount, TotalPenetration, Standard, Remarks
        )
        VALUES (
          @CLNT_ID, @PROJ_ID, @POINT_ID, @TOP, @Base, @Type, @NValue,
          @Blow1, @Blow2, @Blow3, @Blow4, @Blow5, @Blow6,
          @Incr1, @Incr2, @Incr3, @Incr4, @Incr5, @Incr6,
          @TotalBlowCount, @TotalPenetration, @Standard, @Remarks
        );
        SELECT CAST('insert' AS varchar(10)) AS action;
      END
    `);
  return result.recordset?.[0]?.action || "unknown";
}

async function syncCoreGsSpt(records) {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig() || !records.length) return null;

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const transaction = new sql.Transaction(pool);
  const summary = { total: records.length, insert: 0, update: 0 };

  await transaction.begin();
  try {
    for (const record of records) {
      const action = await upsertCoreGsSpt(transaction, record);
      if (action === "insert") summary.insert += 1;
      if (action === "update") summary.update += 1;
    }
    await transaction.commit();
    return summary;
  } catch (error) {
    await transaction.rollback().catch(() => null);
    throw error;
  }
}

async function getCoreGsSptRecords(projId, pointId) {
  if (!CORE_GS_ENABLED || !hasCoreGsConfig()) return [];

  const sql = require("mssql");
  const pool = await getCoreGsPool();
  const result = await pool.request()
    .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
    .input("PROJ_ID", sql.NVarChar(40), projId)
    .input("POINT_ID", sql.NVarChar(40), pointId)
    .query(`
      SELECT
        PROJ_ID,
        POINT_ID,
        [TOP] AS top_depth,
        Base AS base_depth,
        Type,
        NValue,
        Blow1, Blow2, Blow3, Blow4, Blow5, Blow6,
        Incr1, Incr2, Incr3, Incr4, Incr5, Incr6,
        TotalBlowCount,
        TotalPenetration,
        Standard,
        Remarks
      FROM dbo.SPT
      WHERE CLNT_ID = @CLNT_ID
        AND PROJ_ID = @PROJ_ID
        AND POINT_ID = @POINT_ID
      ORDER BY [TOP];
    `);

  return (result.recordset || []).map(row => {
    const blows = [row.Blow1, row.Blow2, row.Blow3, row.Blow4, row.Blow5, row.Blow6]
      .map(value => nullableNumber(value));
    const penetration = [row.Incr1, row.Incr2, row.Incr3, row.Incr4, row.Incr5, row.Incr6]
      .map(value => nullableNumber(value) || 75);
    const nValue = nullableNumber(row.NValue);
    const remarks = nullableText(row.Remarks);
    const sampleRecovery = parseSptSampleRecovery(remarks);
    return {
      record_type: "spt",
      record: {
        id: `spt_coregs_${row.PROJ_ID}_${row.POINT_ID}_${row.top_depth}`,
        GEO_ID: null,
        PROJ_ID: nullableText(row.PROJ_ID),
        POINT_ID: nullableText(row.POINT_ID),
        Type: nullableText(row.Type),
        top: nullableNumber(row.top_depth),
        Base: nullableNumber(row.base_depth),
        nValue,
        refusal: nValue === null ? 1 : 0,
        blows,
        penetration,
        Blow1: nullableNumber(row.Blow1),
        Blow2: nullableNumber(row.Blow2),
        Blow3: nullableNumber(row.Blow3),
        Blow4: nullableNumber(row.Blow4),
        Blow5: nullableNumber(row.Blow5),
        Blow6: nullableNumber(row.Blow6),
        Incr1: nullableNumber(row.Incr1),
        Incr2: nullableNumber(row.Incr2),
        Incr3: nullableNumber(row.Incr3),
        Incr4: nullableNumber(row.Incr4),
        Incr5: nullableNumber(row.Incr5),
        Incr6: nullableNumber(row.Incr6),
        TotalBlowCount: nullableNumber(row.TotalBlowCount),
        TotalPenetration: nullableNumber(row.TotalPenetration),
        Standard: nullableText(row.Standard),
        Remarks: remarks,
        ...sampleRecovery,
        created_at: new Date().toISOString(),
        sync_status: "synced",
        source: "core-gs",
      },
    };
  });
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
      coreGs: {
        enabled: CORE_GS_ENABLED,
        configured: hasCoreGsConfig(),
        clientId: CORE_GS_CLNT_ID,
        host: process.env.CORE_GS_HOST || null,
        instance: process.env.CORE_GS_INSTANCE || null,
        port: process.env.CORE_GS_PORT || null,
      },
    };
  }

  const result = await db.query("SELECT COUNT(*)::int AS count FROM projects");
  return {
    ok: true,
    backend: "postgres",
    projects: result.rows[0]?.count || 0,
    databaseConfigured: true,
    databaseError: null,
    coreGs: {
      enabled: CORE_GS_ENABLED,
      configured: hasCoreGsConfig(),
      clientId: CORE_GS_CLNT_ID,
      host: process.env.CORE_GS_HOST || null,
      instance: process.env.CORE_GS_INSTANCE || null,
      port: process.env.CORE_GS_PORT || null,
    },
  };
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE_NAME, "", {
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
    maxAge: 0,
    expires: new Date(0),
    secure: process.env.NODE_ENV === "production",
  }));
}

function setSessionCookie(res, sessionToken, expiresAt) {
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
    maxAge: Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
    expires: new Date(expiresAt),
    secure: process.env.NODE_ENV === "production",
  }));
}

async function getSessionFromRequest(req) {
  const db = getPool();
  if (!db) throw createHttpError(503, "Authentication requires PostgreSQL configuration");

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || bearerToken;
  if (!sessionToken) return null;

  const result = await db.query(
    `
      SELECT
        s.id AS session_id,
        s.account_id,
        s.expires_at,
        a.user_id,
        u.employee_code,
        u.login_username,
        u.full_name,
        u.initials,
        u.role_title,
        u.app_role,
        u.division,
        u.region,
        u.email,
        u.phone
      FROM app_sessions s
      JOIN app_auth_accounts a ON a.id = s.account_id
      JOIN app_users u ON u.id = a.user_id
      WHERE s.session_token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND a.is_active = true
        AND u.is_active = true
      LIMIT 1
    `,
    [hashToken(sessionToken)]
  );

  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  await db.query("UPDATE app_sessions SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1", [row.session_id]);
  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    expiresAt: row.expires_at,
    user: normalizeUser(row),
  };
}

async function requireAuth(req, res) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    clearSessionCookie(res);
    throw createHttpError(401, "Authentication required.");
  }
  req.auth = session;
  return session;
}

async function loginWithPassword(identifier, password, auditContext = {}) {
  const db = getPool();
  if (!db) throw createHttpError(503, "Authentication requires PostgreSQL configuration");

  const normalizedLogin = String(identifier || "").trim();
  const rawPassword = String(password || "");
  if (!normalizedLogin || !rawPassword) throw createHttpError(400, "Username and password are required.");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query(
      `
        SELECT
          a.id AS account_id,
          a.password_hash,
          a.user_id,
          u.employee_code,
          u.login_username,
          u.full_name,
          u.initials,
          u.role_title,
          u.app_role,
          u.division,
          u.region,
          u.email,
          u.phone
        FROM app_auth_accounts a
        JOIN app_users u ON u.id = a.user_id
        WHERE (
          LOWER(u.login_username) = LOWER($1)
          OR LOWER(a.login_email) = $2
        )
          AND a.is_active = true
          AND u.is_active = true
        LIMIT 1
        FOR UPDATE
      `,
      [normalizeLoginUsername(normalizedLogin), normalizeLoginEmail(normalizedLogin)]
    );

    if (accountResult.rowCount === 0 || !verifyPassword(rawPassword, accountResult.rows[0].password_hash)) {
      if (accountResult.rowCount > 0) {
        await client.query(
          `UPDATE app_auth_accounts
           SET failed_login_count = COALESCE(failed_login_count, 0) + 1,
               last_failed_login_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [accountResult.rows[0].account_id]
        ).catch(() => null);
      }
      await client.query("COMMIT");
      throw createHttpError(401, "Invalid username or password.");
    }

    const account = accountResult.rows[0];
    const sessionToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);
    const sessionInsert = await client.query(
      `
        INSERT INTO app_sessions (account_id, session_token_hash, expires_at, last_seen_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id, expires_at
      `,
      [account.account_id, hashToken(sessionToken), expiresAt]
    );

    await client.query(
      `UPDATE app_auth_accounts
       SET last_login_at = NOW(),
           failed_login_count = 0,
           last_failed_login_at = NULL,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [account.account_id]
    ).catch(() => null);

    await recordAuthEvent({
      eventType: "login_succeeded",
      accountId: account.account_id,
      userId: account.user_id,
      sessionId: sessionInsert.rows[0].id,
      loginIdentifier: normalizedLogin,
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
      metadata: { app: "substrata-field", expiresAt: sessionInsert.rows[0].expires_at },
      client,
    });

    await client.query("COMMIT");
    return {
      sessionId: sessionInsert.rows[0].id,
      sessionToken,
      expiresAt: sessionInsert.rows[0].expires_at,
      user: normalizeUser(account),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function revokeSession(sessionId, auditContext = {}) {
  const db = getPool();
  if (!db || !sessionId) return;
  const result = await db.query(
    `UPDATE app_sessions
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING id, account_id`,
    [sessionId]
  );
  if (result.rowCount === 0) return;
  await recordAuthEvent({
    eventType: "logout",
    accountId: result.rows[0].account_id,
    sessionId: result.rows[0].id,
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
    metadata: { app: "substrata-field" },
  });
}

async function recordAuthEvent({ eventType, accountId = null, userId = null, sessionId = null, loginIdentifier = null, ipAddress = null, userAgent = null, metadata = {}, client = null }) {
  const db = client || getPool();
  if (!db || !eventType) return;
  await db.query(
    `
      INSERT INTO app_auth_events (
        event_type, account_id, user_id, session_id, login_identifier, ip_address, user_agent, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      eventType,
      accountId,
      userId,
      sessionId,
      normalizeLoginEmail(loginIdentifier),
      ipAddress || null,
      userAgent || null,
      JSON.stringify(metadata || {}),
    ]
  ).catch(() => null);
}

async function syncPoints(points) {
  const db = getPool();
  if (!db) throw createHttpError(503, "Sync requires PostgreSQL configuration");
  if (!Array.isArray(points)) throw createHttpError(400, "points must be an array");

  const validPoints = points.filter(point => point?.PROJ_ID && point?.POINT_ID);
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const saved = [];
    for (const point of validPoints) {
      await ensureCachedProjectForPoint(client, point.PROJ_ID);
      await client.query(
        `INSERT INTO points (
           proj_id, point_id, type, hole_depth, location, remarks, status, rig, driller_lookup, grid
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (proj_id, point_id) DO UPDATE
         SET type = EXCLUDED.type,
             hole_depth = EXCLUDED.hole_depth,
             location = EXCLUDED.location,
             remarks = EXCLUDED.remarks,
             status = EXCLUDED.status,
             rig = EXCLUDED.rig,
             driller_lookup = EXCLUDED.driller_lookup,
             grid = EXCLUDED.grid`,
        [
          point.PROJ_ID,
          point.POINT_ID,
          point.Type || null,
          point.HoleDepth ?? null,
          point.Location || null,
          point.Remarks || null,
          point.Status || null,
          point.Rig || null,
          point.DrillerLookup || null,
          point.Grid || null,
        ]
      );
      saved.push(`${point.PROJ_ID}:${point.POINT_ID}`);
    }
    await client.query("COMMIT");
    committed = true;
    await syncCoreGsPoints(validPoints);
    return saved;
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureCachedProjectForPoint(client, projId) {
  const existing = await client.query("SELECT 1 FROM projects WHERE proj_id = $1", [projId]);
  if (existing.rowCount > 0) return;

  let project = null;
  if (CORE_GS_ENABLED && hasCoreGsConfig()) {
    const sql = require("mssql");
    const pool = await getCoreGsPool();
    const result = await pool.request()
      .input("CLNT_ID", sql.NVarChar(40), CORE_GS_CLNT_ID)
      .input("PROJ_ID", sql.NVarChar(40), projId)
      .query(`
        SELECT
          PROJ_ID AS PROJ_ID,
          PROJ_NAME AS PROJ_NAME,
          Location AS Location,
          Client AS Client,
          Engineer AS Engineer
        FROM dbo.PROJECT
        WHERE CLNT_ID = @CLNT_ID AND PROJ_ID = @PROJ_ID;
      `);
    project = result.recordset?.[0] || null;
  }

  if (!project) throw createHttpError(400, `Project ${projId} is not cached and could not be read from CORE-GS`);

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
      project.PROJ_NAME || project.PROJ_ID,
      project.Location || null,
      project.Client || null,
      project.Engineer || null,
    ]
  );
}

async function syncRecords(records) {
  const db = getPool();
  if (!db) throw createHttpError(503, "Sync requires PostgreSQL configuration");
  if (!Array.isArray(records)) throw createHttpError(400, "records must be an array");

  const client = await db.connect();
  const coreGsGeology = [];
  const coreGsSpt = [];
  let committed = false;
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
      if (recordType === "geology") coreGsGeology.push(record);
      if (recordType === "spt") coreGsSpt.push(record);
    }
    await client.query("COMMIT");
    committed = true;
    await syncCoreGsGeology(coreGsGeology);
    await syncCoreGsSpt(coreGsSpt);
    return saved;
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getSyncedRecords(projId, pointId) {
  const db = getPool();
  const coreGsRecords = [
    ...(await getCoreGsGeologyRecords(projId, pointId)),
    ...(await getCoreGsSptRecords(projId, pointId)),
  ];
  if (!db) return coreGsRecords;

  const result = await db.query(
    `SELECT record_type, payload
     FROM job_records
     WHERE proj_id = $1 AND point_id = $2
     ORDER BY created_at NULLS LAST, record_type, record_id`,
    [projId, pointId]
  );

  const postgresRecords = result.rows.map(row => ({
    record_type: row.record_type,
    record: { ...row.payload, sync_status: "synced" },
  }));
  const seen = new Set(postgresRecords.map(item =>
    `${item.record_type}:${item.record.PROJ_ID}:${item.record.POINT_ID}:${item.record.top}:${item.record.base || ""}`
  ));
  const mergedCoreGsRecords = coreGsRecords.filter(item =>
    !seen.has(`${item.record_type}:${item.record.PROJ_ID}:${item.record.POINT_ID}:${item.record.top}:${item.record.base || ""}`)
  );
  return [...postgresRecords, ...mergedCoreGsRecords];
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
  if (statusCode === 204) {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
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

  if (url.pathname === "/api/session" && req.method === "GET") {
    const session = await requireAuth(req, res);
    sendJson(res, 200, {
      user: session.user,
      expiresAt: session.expiresAt,
      sessionToken: session.sessionToken,
    });
    return;
  }

  if (url.pathname === "/api/session/login" && req.method === "POST") {
    const body = await readRequestBody(req);
    const session = await loginWithPassword(
      body.username || body.email,
      body.password,
      getAuditContext(req)
    );
    setSessionCookie(res, session.sessionToken, session.expiresAt);
    sendJson(res, 200, {
      user: session.user,
      expiresAt: session.expiresAt,
      sessionToken: session.sessionToken,
    });
    return;
  }

  if (url.pathname === "/api/session/logout" && req.method === "DELETE") {
    let session = null;
    try {
      session = await getSessionFromRequest(req);
    } catch (error) {
      if (error.statusCode !== 503) throw error;
    }
    if (session) await revokeSession(session.sessionId, getAuditContext(req));
    clearSessionCookie(res);
    sendJson(res, 204, null);
    return;
  }

  await requireAuth(req, res);

  if (url.pathname === "/api/core-gs/status" && req.method === "GET") {
    sendJson(res, 200, {
      enabled: CORE_GS_ENABLED,
      configured: hasCoreGsConfig(),
      host: process.env.CORE_GS_HOST || null,
      instance: process.env.CORE_GS_INSTANCE || null,
      port: process.env.CORE_GS_PORT || null,
      database: process.env.CORE_GS_DATABASE || null,
      user: process.env.CORE_GS_USER || null,
      clientId: CORE_GS_CLNT_ID,
    });
    return;
  }

  if (url.pathname === "/api/core-gs/test-connection" && req.method === "POST") {
    sendJson(res, 200, await testCoreGsConnection());
    return;
  }

  if (url.pathname === "/api/core-gs/schema/tables" && req.method === "GET") {
    try {
      sendJson(res, 200, {
        ok: true,
        tables: await getCoreGsTables(url.searchParams.get("search") || ""),
      });
    } catch (error) {
      throw createCoreGsError(error, "CORE-GS table discovery");
    }
    return;
  }

  if (url.pathname === "/api/core-gs/schema/table" && req.method === "GET") {
    try {
      sendJson(res, 200, {
        ok: true,
        ...(await getCoreGsTableDetails({
          schema: url.searchParams.get("schema") || "dbo",
          table: url.searchParams.get("table"),
          sampleLimit: url.searchParams.get("sample") || 0,
        })),
      });
    } catch (error) {
      if (error?.statusCode && error.statusCode < 500) throw error;
      throw createCoreGsError(error, "CORE-GS table inspection");
    }
    return;
  }

  if (url.pathname === "/api/core-gs/lookups" && req.method === "GET") {
    try {
      sendJson(res, 200, {
        ok: true,
        lookups: await getCoreGsLookupTables(),
      });
    } catch (error) {
      throw createCoreGsError(error, "CORE-GS lookup discovery");
    }
    return;
  }

  if (url.pathname === "/api/core-gs/lookup-values" && req.method === "GET") {
    try {
      sendJson(res, 200, {
        ok: true,
        schema: url.searchParams.get("schema") || "dbo",
        table: url.searchParams.get("table"),
        values: await getCoreGsLookupValues({
          schema: url.searchParams.get("schema") || "dbo",
          table: url.searchParams.get("table"),
          limit: url.searchParams.get("limit") || 200,
        }),
      });
    } catch (error) {
      if (error?.statusCode && error.statusCode < 500) throw error;
      throw createCoreGsError(error, "CORE-GS lookup read");
    }
    return;
  }

  if (url.pathname === "/api/lookups/hole-types" && req.method === "GET") {
    try {
      sendJson(res, 200, await getHoleTypes());
    } catch (error) {
      throw createCoreGsError(error, "CORE-GS hole type read");
    }
    return;
  }

  if (url.pathname === "/api/lookups/point-fields" && req.method === "GET") {
    try {
      sendJson(res, 200, await getPointFieldLookups());
    } catch (error) {
      throw createCoreGsError(error, "CORE-GS point lookup read");
    }
    return;
  }

  if (url.pathname === "/api/projects") {
    try {
      sendJson(res, 200, await getProjects());
    } catch (error) {
      if (CORE_GS_ENABLED && hasCoreGsConfig()) throw createCoreGsError(error, "CORE-GS project read");
      throw error;
    }
    return;
  }

  if (url.pathname === "/api/points") {
    const projId = url.searchParams.get("proj_id");
    if (!projId) {
      sendJson(res, 400, { error: "proj_id is required" });
      return;
    }
    try {
      sendJson(res, 200, await getPoints(projId));
    } catch (error) {
      if (CORE_GS_ENABLED && hasCoreGsConfig()) throw createCoreGsError(error, "CORE-GS point read");
      throw error;
    }
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
    try {
      sendJson(res, 200, { ok: true, records: await getSyncedRecords(projId, pointId) });
    } catch (error) {
      if (CORE_GS_ENABLED && hasCoreGsConfig()) throw createCoreGsError(error, "CORE-GS geology read");
      throw error;
    }
    return;
  }

  if (url.pathname === "/api/sync/records" && req.method === "POST") {
    const body = await readRequestBody(req);
    try {
      const saved = await syncRecords(body.records || []);
      sendJson(res, 200, { ok: true, saved });
    } catch (error) {
      if (error?.statusCode && error.statusCode < 500) throw error;
      if (CORE_GS_ENABLED && hasCoreGsConfig()) throw createCoreGsError(error, "CORE-GS record sync");
      throw error;
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      if (!["GET", "POST", "DELETE"].includes(req.method)) {
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
      await seedAuthIfNeeded();
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
