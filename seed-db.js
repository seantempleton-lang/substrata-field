const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DATA_PATH = process.env.SUBSTRATA_API_DATA || path.join(__dirname, "api-data.json");

function getPool() {
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

  return new Pool(config);
}

function readSeedData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS projects (
      proj_id TEXT PRIMARY KEY,
      proj_name TEXT NOT NULL,
      location TEXT,
      client TEXT,
      engineer TEXT
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS points (
      proj_id TEXT NOT NULL REFERENCES projects(proj_id) ON DELETE CASCADE,
      point_id TEXT NOT NULL,
      type TEXT,
      hole_depth DOUBLE PRECISION,
      location TEXT,
      PRIMARY KEY (proj_id, point_id)
    );
  `);
}

async function seed() {
  const pool = getPool();
  const client = await pool.connect();
  const data = readSeedData();

  try {
    await client.query("BEGIN");
    await ensureSchema(client);

    for (const project of data.projects || []) {
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
    console.log(`Seeded ${data.projects?.length || 0} projects into PostgreSQL.`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
