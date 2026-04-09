BEGIN;

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
