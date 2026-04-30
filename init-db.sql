BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_login_username_lower
ON app_users (LOWER(login_username));

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

CREATE INDEX IF NOT EXISTS idx_app_sessions_active
ON app_sessions (session_token_hash, expires_at)
WHERE revoked_at IS NULL;

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

CREATE INDEX IF NOT EXISTS idx_app_auth_events_type_created_at
ON app_auth_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  proj_id TEXT PRIMARY KEY,
  proj_name TEXT NOT NULL,
  location TEXT,
  client TEXT,
  engineer TEXT
);

CREATE TABLE IF NOT EXISTS points (
  proj_id TEXT NOT NULL REFERENCES projects(proj_id) ON DELETE CASCADE,
  point_id TEXT NOT NULL,
  type TEXT,
  hole_depth DOUBLE PRECISION,
  location TEXT,
  PRIMARY KEY (proj_id, point_id)
);

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

CREATE INDEX IF NOT EXISTS idx_job_records_job
ON job_records (proj_id, point_id, record_type, created_at);

WITH seed_users AS (
  SELECT *
  FROM (VALUES
    ('EMP-001', 'SeanTempleton', 'Sean Templeton', 'ST', 'Lead Geotech', 'SuperUser', 'Geotech', 'South', 'sean@example.com', 'sean@example.com', 'scrypt$3178da955ccb5d7e8edead16b3aeb8ed$4765c4939153ad5b736d0f4f1b9f7e1367b45d021f040829c82298b4f811093cea24b0acf22da1917344c9d75b82b5e2ddef69ffd3162f0767c24d22fbe958aa'),
    ('EMP-004', 'TraceyFlatman', 'Tracey Flatman', 'TF', 'Administrator', 'Administrator', 'Operations', 'South', 'tracey.flatman@drilling.co.nz', 'tracey.flatman@drilling.co.nz', 'scrypt$f5e65d0eb31b2accc16412ec634ff592$a3b426c416cd9b2722ce4ac608e1bbf8d40965b2797921a537687918360ca7c25bd2941af7581d5a2796254b8d69e7bbda3d6b3156c675a2736b3f66001f5f61'),
    ('EMP-006', 'TomLubbe', 'Tom Lubbe', 'TL', 'Supervisor', 'Supervisor', 'Geotech', 'South', 'tom.lubbe@drilling.co.nz', 'tom.lubbe@drilling.co.nz', 'scrypt$b187ab906b1f7668bb10c78065a48631$c28ecfe9362f9f8004dc7f069add7391c8d05408d172493a6930f4305f2dcaf6caf8459fd7c7f84a7161402a992303d3a4d1f966fb5404d03fb509b0aa7d7991'),
    ('EMP-009', 'GregCossar', 'Greg Cossar', 'GC', 'Field Technician', 'FieldUser', 'Geotech', 'South', 'greg.cossar@drilling.co.nz', 'greg.cossar@drilling.co.nz', 'scrypt$21a1f6d5036842a2e5e27ff5e0998904$076b3ba07d67c1ec924348073341f34f942d659c01b397d899e4578f497051f0d1450a1dbdc92f35bb6e3d0f003eb63f5d12c56737cc5de71bd2149af6f1548b'),
    ('EMP-010', 'RahulNegi', 'Rahul Negi', 'RN', 'Field Technician', 'FieldUser', 'Geotech', 'South', 'rahulnegi@drilling.co.nz', 'rahulnegi@drilling.co.nz', 'scrypt$34c10e38ab1c21c1416a827e6eafc13b$e23188bf3dd1f57ee39e92db52c4f9f85444d41e939f34d19a2ec59d18f56f43732f0eaf94ebbc9ff6780f364a61cc77382785e19c924e5d8f82e34664df08d4')
  ) AS v(employee_code, login_username, full_name, initials, role_title, app_role, division, region, email, login_email, password_hash)
),
upserted_users AS (
  INSERT INTO app_users (
    employee_code, login_username, full_name, initials, role_title,
    app_role, division, region, email
  )
  SELECT employee_code, login_username, full_name, initials, role_title,
    app_role, division, region, email
  FROM seed_users
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
  RETURNING id, employee_code
)
INSERT INTO app_auth_accounts (user_id, login_email, password_hash, is_active)
SELECT u.id, s.login_email, s.password_hash, true
FROM upserted_users u
JOIN seed_users s ON s.employee_code = u.employee_code
ON CONFLICT (user_id) DO UPDATE
SET login_email = EXCLUDED.login_email,
    password_hash = EXCLUDED.password_hash,
    is_active = true,
    updated_at = NOW();

INSERT INTO projects (proj_id, proj_name, location, client, engineer) VALUES
  ('2024-041', 'Wigram Residential Development', 'Wigram, Christchurch', 'Propertyco Ltd', 'S. Templeton'),
  ('2024-058', 'Bealey Ave Retaining Wall', 'Bealey Ave, Christchurch Central', 'Christchurch City Council', 'A. Williams'),
  ('2024-063', 'Belfast Industrial Subdivision', 'Belfast, Christchurch', 'Northland Developments', 'S. Templeton'),
  ('2024-071', 'Lyttelton Port Wharf Strengthening', 'Lyttelton Harbour', 'Lyttelton Port Company', 'M. Chen'),
  ('2025-003', 'Kaikoura SH1 Slope Stability', 'State Highway 1, Kaikoura Coast', 'NZTA', 'D. Burns'),
  ('2025-011', 'Rolleston Industrial Park Stage 3', 'Rolleston, Selwyn District', 'Selwyn Commercial Trust', 'S. Templeton'),
  ('2025-019', 'Rangiora Town Centre Redevelopment', 'Rangiora, Waimakariri', 'Waimakariri District Council', 'A. Williams'),
  ('2025-027', 'Halswell Quarry Park Infrastructure', 'Halswell, Christchurch', 'CCC Parks', 'M. Chen')
ON CONFLICT (proj_id) DO UPDATE
SET
  proj_name = EXCLUDED.proj_name,
  location = EXCLUDED.location,
  client = EXCLUDED.client,
  engineer = EXCLUDED.engineer;

INSERT INTO points (proj_id, point_id, type, hole_depth, location) VALUES
  ('2024-041', 'BH01', 'BH', 12.0, 'NW corner of site, 3m from boundary fence'),
  ('2024-041', 'BH02', 'BH', 15.0, 'Central building footprint, grid A3'),
  ('2024-041', 'BH03', 'BH', 10.0, 'SE corner near stormwater reserve'),
  ('2024-041', 'TP01', 'TP', 3.5, 'Driveway area, western access'),
  ('2024-041', 'TP02', 'TP', 3.0, 'Rear section, proposed retaining wall'),

  ('2024-058', 'BH01', 'BH', 8.0, 'Top of bank, 2m east of kerb'),
  ('2024-058', 'BH02', 'BH', 8.0, 'Mid-slope, existing retaining wall'),
  ('2024-058', 'BH03', 'BH', 10.0, 'Toe of bank, footpath edge'),

  ('2024-063', 'BH01', 'BH', 20.0, 'Lot 12 - heavy industrial zone'),
  ('2024-063', 'BH02', 'BH', 20.0, 'Lot 7 - light industrial zone'),
  ('2024-063', 'BH03', 'BH', 15.0, 'Road reserve, proposed main entrance'),
  ('2024-063', 'CPT01', 'CPT', 18.0, 'Central area, proposed building A'),
  ('2024-063', 'CPT02', 'CPT', 18.0, 'Western area, proposed building B'),
  ('2024-063', 'CPT03', 'CPT', 18.0, 'Eastern area, proposed car park'),

  ('2024-071', 'BH01', 'BH', 30.0, 'Wharf pile cap, Berth 5 north'),
  ('2024-071', 'BH02', 'BH', 30.0, 'Wharf pile cap, Berth 5 south'),
  ('2024-071', 'BH03', 'BH', 25.0, 'Reclamation zone, eastern edge'),

  ('2025-003', 'BH01', 'BH', 15.0, 'Crest of failed slope, Chainage 14+200'),
  ('2025-003', 'BH02', 'BH', 12.0, 'Mid-slope, Chainage 14+200'),
  ('2025-003', 'BH03', 'BH', 15.0, 'Toe of slope, Chainage 14+200'),
  ('2025-003', 'BH04', 'BH', 12.0, 'Crest of slope, Chainage 14+650'),

  ('2025-011', 'BH01', 'BH', 15.0, 'Stage 3 northern boundary'),
  ('2025-011', 'BH02', 'BH', 15.0, 'Stage 3 central'),
  ('2025-011', 'BH03', 'BH', 15.0, 'Stage 3 southern boundary'),
  ('2025-011', 'TP01', 'TP', 3.0, 'Existing fill, NW area'),
  ('2025-011', 'TP02', 'TP', 3.0, 'Existing fill, SE area'),

  ('2025-019', 'BH01', 'BH', 12.0, 'Proposed library site, Southbrook Rd'),
  ('2025-019', 'BH02', 'BH', 12.0, 'Proposed carpark, High St'),
  ('2025-019', 'TP01', 'TP', 2.5, 'Footpath upgrade, north'),

  ('2025-027', 'BH01', 'BH', 8.0, 'Proposed amenities building'),
  ('2025-027', 'BH02', 'BH', 6.0, 'Proposed carpark extension')
ON CONFLICT (proj_id, point_id) DO UPDATE
SET
  type = EXCLUDED.type,
  hole_depth = EXCLUDED.hole_depth,
  location = EXCLUDED.location;

COMMIT;
