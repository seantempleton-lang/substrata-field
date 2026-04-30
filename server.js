const http = require("http");
const fs = require("fs");
const path = require("path");
const { createHash, randomBytes, scryptSync, timingSafeEqual } = require("crypto");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const APP_DIR = path.join(__dirname, "substrata-field");
const DATA_PATH = process.env.SUBSTRATA_API_DATA || path.join(__dirname, "api-data.json");
const SHOULD_SEED = String(process.env.SUBSTRATA_SEED_DB || "true").toLowerCase() !== "false";
const SESSION_COOKIE_NAME = "substrata_session";
const SESSION_DURATION_DAYS = 30;
const APP_ROLE_ORDER = ["FieldUser", "Maintenance", "Supervisor", "Administrator", "SuperUser"];
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
let dbDisabledReason = null;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

async function seedAuthIfNeeded() {
  const db = getPool();
  if (!db || !SHOULD_SEED) return;

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
    sendJson(res, 200, { user: session.user, expiresAt: session.expiresAt });
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
