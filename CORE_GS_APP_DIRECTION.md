# SubStrata Field and CORE-GS Direction

Last updated: 2026-06-23

## Source Of Truth

The workbook below is the current source of truth for CORE-GS database structure:

```text
C:\Users\SeanTempleton\OneDrive - McMillan Drilling Ltd\Work\Coding\coregs_tables.xlsx
```

Before adding or changing any CORE-GS read/write path, check this workbook for exact table names, column names, nullability, indexes, foreign keys, and lookup structures. Do not rely on memory when schema details matter.

The workbook contains:

- `coregs_tables`
- `coregs_columns`
- `coregs_foreignkeys`
- `coregs_indexes`
- `coregs_lookups`

Recent observed workbook shape:

- 136 table rows including header
- 1,463 column rows including header
- 357 foreign-key rows including header
- 592 index rows including header
- 133,142 lookup rows including header

## Current Decision

SubStrata Field should not be rebuilt from scratch.

The existing app shell is still useful:

- Field auth and session handling
- Mobile/PWA install behavior
- Bottom module navigation
- IndexedDB local cache and pending-sync pattern
- Existing field-entry screens
- Node API bridge
- Postgres database for app-owned auth, sessions, audit, cache, and queue data
- MSSQL connection to CORE-GS

CORE-GS is the source of truth for projects, points, lookup values, and production field records. Postgres and IndexedDB are support layers, not competing databases for CORE-GS business data.

## Architecture Direction

The mobile app must not talk to SQL Server directly.

The intended flow is:

```text
Mobile PWA
  -> SubStrata Field API
  -> CORE-GS MSSQL database

Mobile PWA
  -> IndexedDB for offline cache and pending local edits

SubStrata Field API
  -> Postgres for app auth, sessions, sync queue/cache, and audit data
```

Postgres is still needed, but its job should stay narrow:

- App users, auth accounts, sessions, and audit events
- Pending sync queue and replay state
- App-owned cache needed for offline resume
- Error state and retry metadata

Postgres should not become the source of truth for `PROJECT`, `POINT`, `GEOLOGY`, or other CORE-GS business tables.

## Current CORE-GS Connection

The deployed app has successfully connected to CORE-GS.

Known CORE-GS configuration:

- Host: `192.168.1.50`
- Instance: `SQLSTANDARD2019`
- Port: `1435`
- Database: `CORE-GS-TEST`
- SQL login user: `api.qgis`
- App client id / `CLNT_ID`: `Geotechnical`

Do not commit the SQL password to the repo. It should live only in deployment environment variables.

The API health response previously confirmed:

- CORE-GS bridge enabled
- CORE-GS configured
- SQL Server reachable
- Login authenticated as `api.qgis`
- Database is `CORE-GS-TEST`
- Server is `DRILLING-PC08\SQLSTANDARD2019`

## Current Build State

### Phase 1 - CORE-GS Reads

Phase 1 is effectively complete.

- `/api/projects` reads from `dbo.PROJECT` when CORE-GS is enabled.
- `/api/points?proj_id=...` reads from `dbo.POINT` when CORE-GS is enabled.
- Reads are scoped by `CLNT_ID = Geotechnical`.
- The Jobs tab refresh action is `Refresh from CORE-GS`.
- The obsolete seeded-project push UI was removed.
- API routes are not cached by the service worker.
- Seed/demo data remains only as explicit local fallback, not the production source of truth.

### Phase 2 - POINT Create/Sync

Phase 2 has started and the first pass is implemented.

Current state:

- New point creation uses live CORE-GS lookup values.
- `/api/lookups/point-fields` returns point form lookups:
  - `LUT_HoleType`
  - `LUT_HoleStatus`
  - `Rig`
  - `DrillerLookup`
  - `Grids`
- `Rig`, `DrillerLookup`, and `Grids` lookup reads are scoped by `CLNT_ID`.
- New point form supports:
  - `POINT_ID`
  - `Type`
  - `HoleDepth`
  - `Location`
  - `Remarks`
  - `Status`
  - `Rig`
  - `DrillerLookup`
  - `Grid`
- `/api/sync/points` writes pending point edits through to CORE-GS when enabled.
- POINT upsert validates lookup values before write instead of silently remapping or nulling invalid values.
- The lingering fallback that treated missing point type as `BH` was removed.

Important limitation:

- Full point editing of existing CORE-GS points is not yet complete as a separate edit screen/workflow. Current work is focused on new point creation and sync.

### Phase 3 - GEOLOGY Write

Phase 3 has started with the Geology module.

Current state:

- Existing Geology UI still builds rich NZGS soil/rock descriptions.
- Saved geology records remain offline-capable through IndexedDB.
- Pending geology records sync through `/api/sync/records`.
- When CORE-GS is enabled, geology records are upserted into `dbo.GEOLOGY`.
- Existing CORE-GS geology rows are read back into app history through `/api/sync/records?proj_id=...&point_id=...`.

Current `dbo.GEOLOGY` write columns:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `TOP`
- `BASE`
- `Description`
- `Remarks`
- `MoistureCondition`

Current `dbo.GEOLOGY` read columns:

- `PROJ_ID`
- `POINT_ID`
- `TOP`
- `BASE`
- `Description`
- `Remarks`
- `MoistureCondition`
- `Legend`

Current Geology rules:

- Natural key is `CLNT_ID, PROJ_ID, POINT_ID, TOP, BASE`.
- `GEO_ID` is not supplied by the app.
- `rts` is not read or written.
- `dbo.GEOLOGY` does not have `_timestamp`; do not reference it.
- SQL aliases should avoid reserved words such as `top`; use safe aliases such as `top_depth` and `base_depth`.
- Geology write validates the target `POINT` exists in CORE-GS first.
- Deleting geology is still local-only. Synced CORE-GS rows will reappear when records are hydrated.

Moisture behavior:

- The existing UI moisture selector is preserved, including range selection.
- Saved soil geology records carry `MoistureCondition` from the current moisture selector.
- Server resolves that text against `dbo.LUT_MoistureType` using:
  - `TypeID`
  - `Code`
  - `Description`
- If the selection is a single value such as `moist`, it should populate if CORE-GS has a matching lookup.
- If the selection is a range such as `dry to moist`, it only populates `MoistureCondition` if CORE-GS has that exact lookup. Otherwise the range remains in `Description`, and `MoistureCondition` is left `NULL`.

### Phase 3 - SPT Write

SPT sync has also started.

Current state:

- Existing SPT UI still records six 75 mm increments, seating/test blows, refusal state, total penetration, and calculated N value.
- SPT setup now requires sampler type:
  - `S`: Raymond Split Spoon
  - `C`: Solid Cone
- Spoon SPT tests now prompt for sample recovery after the test is complete:
  - `450 mm = 100%`.
  - Cone SPT tests do not prompt for recovery because no sample is collected.
  - `dbo.SPT` does not have a dedicated recovery column, so the current implementation stores the structured value in the app record payload and writes a compact `Sample recovery: ...` note into `SPT.Remarks` for CORE-GS continuity.
- Saved SPT records remain offline-capable through IndexedDB.
- Pending SPT records sync through `/api/sync/records`.
- When CORE-GS is enabled, SPT records are upserted into `dbo.SPT`.
- Existing CORE-GS SPT rows are read back into app history through `/api/sync/records?proj_id=...&point_id=...`.

Current `dbo.SPT` write columns:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `Type`
- `TOP`
- `Base`
- `NValue`
- `Blow1` through `Blow6`
- `Incr1` through `Incr6`
- `TotalBlowCount`
- `TotalPenetration`
- `Standard`
- `Remarks`

Current SPT rules:

- Natural key is `CLNT_ID, PROJ_ID, POINT_ID, TOP`.
- `GEO_ID` is not supplied by the app.
- `rts` is not read or written.
- `Type` is selected in the SPT setup UI and validated against `dbo.LUT_SptType.Value`.
- SQL aliases should avoid reserved words such as `top`; use safe aliases such as `top_depth`.
- SPT write validates the target `POINT` exists in CORE-GS first.
- Deleting SPT is still local-only. Synced CORE-GS rows will reappear when records are hydrated.

## Protected CORE-GS Inspection Endpoints

These endpoints are authenticated-only:

```text
GET /api/core-gs/status
POST /api/core-gs/test-connection
GET /api/core-gs/schema/tables
GET /api/core-gs/schema/tables?search=POINT
GET /api/core-gs/schema/table?schema=dbo&table=POINT
GET /api/core-gs/schema/table?schema=dbo&table=POINT&sample=10
GET /api/core-gs/lookups
GET /api/core-gs/lookup-values?schema=dbo&table=LUT_HoleType
```

These are useful for inspection and debugging. Production writes should still be explicit and table-specific.

## Critical CORE-GS Rules

### Client Scope

Always scope CORE-GS reads and writes by:

```text
CLNT_ID = Geotechnical
```

This is not optional where the target table has `CLNT_ID`.

### Primary Key Pattern

Most CORE-GS tables use:

```text
GEO_ID uniqueidentifier default newid()
```

as the physical primary key.

The app should normally not generate or depend on `GEO_ID` for idempotent writes. Use each table's natural unique key for upsert behavior.

### Rowversion

Many tables contain:

```text
rts timestamp
```

This is SQL Server `timestamp` / `rowversion`. The app must not insert or update `rts`. SQL Server generates it.

If a required-column scan says `rts` is required, ignore that for app input design.

### Lookup And Foreign Key Values

Do not invent lookup values.

If a field is backed by a lookup or FK table, the UI should read valid values from CORE-GS and submit the actual lookup code. Avoid hardcoded mappings unless they are documented business rules.

Example failure already seen:

- App tried to write `POINT.Type = BH`.
- CORE-GS rejected it because `BH` is not in `dbo.LUT_HoleType.VALUE`.
- Correct fix is not blind remapping. Correct fix is to make the UI use real `LUT_HoleType` values.

## Natural Keys And Major Tables

Use these keys for idempotent read/update behavior. Confirm against `coregs_tables.xlsx` before implementation.

### PROJECT

Table: `dbo.PROJECT`

Natural unique key:

```text
CLNT_ID, PROJ_ID
```

Important columns:

- `CLNT_ID`
- `PROJ_ID`
- `PROJ_NAME`
- `Location`
- `Client`
- `Engineer`

Important cautions:

- `PROJECT.Client` must match an existing `Clients.CLIENT_ID` for the same `CLNT_ID`.

### POINT

Table: `dbo.POINT`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID
```

Current implemented write fields include:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `Type`
- `HoleDepth`
- `Location`
- `Remarks`
- `Status`
- `Rig`
- `DrillerLookup`
- `Grid`

Important foreign keys:

- `CLNT_ID, PROJ_ID -> PROJECT.CLNT_ID, PROJECT.PROJ_ID`
- `Type -> LUT_HoleType.VALUE`
- `Status -> LUT_HoleStatus.VALUE`
- `Grid -> Grids.VALUE`
- `Rig -> Rig.VALUE`
- `DrillerLookup -> DrillerLookup.VALUE`
- `Cap -> LUT_Cap.VALUE`
- `LocationMethod -> LUT_LocationMethodType.VALUE`
- `Termination -> LUT_TerminationType.TypeID`

### GEOLOGY

Table: `dbo.GEOLOGY`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, TOP, BASE
```

Workbook-confirmed columns used by current code:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `Type`
- `TOP`
- `BASE`
- `Description`
- `Remarks`
- `MoistureCondition`
- `Legend`

Important lookup/FK fields:

- `Legend -> GPHX_Geological.Value`
- `ConsistencyDensity -> LUT_ConsistencyDensityType.TypeID`
- `MoistureCondition -> LUT_MoistureType.TypeID`
- `SoilClassification -> LUT_USCType.TypeID`

Important caution:

- `dbo.GEOLOGY` has `rts`, not `_timestamp`.

### SPT

Table: `dbo.SPT`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, TOP
```

Important lookup:

- `Type -> LUT_SptType.Value`

Current implemented write fields:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `TOP`
- `Base`
- `NValue`
- `Blow1` through `Blow6`
- `Incr1` through `Incr6`
- `TotalBlowCount`
- `TotalPenetration`
- `Standard`
- `Remarks`

### Core

Table: `dbo.Core`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, TOP, BASE
```

Important lookup:

- `Drivability -> LUT_CoreDrivability.VALUE`

### Backfill

Table: `dbo.Backfill`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, TOP, BASE
```

Important lookup:

- `Legend -> GPHX_Backfill.Value`

### Water

Table: `dbo.Water`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, DATETIME
```

Important lookup:

- `Type -> LUT_WaterType.TypeID`

### Construction

Table: `dbo.Construction`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, TOP, BASE, TYPE
```

Important lookup/FK fields:

- `TYPE -> LUT_HoleType.VALUE`
- `Diameter -> Diameter.VALUE`
- `Contractor -> Contractors.ContractorID`

### Consumables

Table: `dbo.Consumables`

Natural unique key:

```text
CLNT_ID, PROJ_ID, DATE, RIG, ITEM
```

Important caution:

- `Consumables` references `SiteRecords` by `CLNT_ID, PROJ_ID, DATE, RIG`.
- App design may need to create or select the correct `SiteRecords` row before inserting consumables.

### Piezometer Tables

Tables:

- `dbo.Piezometers_INST`
- `dbo.Piezometers_PIPE`
- `dbo.Piezometers_VIBE`

Natural keys:

```text
Piezometers_INST:
CLNT_ID, PROJ_ID, POINT_ID, ITEM

Piezometers_PIPE:
CLNT_ID, PROJ_ID, POINT_ID, ITEM, TOP, BASE

Piezometers_VIBE:
CLNT_ID, PROJ_ID, POINT_ID, ITEM, TOP
```

Important spelling caution:

```text
LUT_PeizometerType
```

The table name appears to be spelled `Peizometer`, not `Piezometer`. Preserve the real spelling.

## Key Lookup Tables

Use live lookup reads wherever possible.

Important lookup-like tables:

- `LUT_HoleType`
- `LUT_HoleStatus`
- `LUT_MoistureType`
- `LUT_SptType`
- `LUT_CoreDrivability`
- `LUT_InstallationType`
- `LUT_PeizometerType`
- `LUT_PiezometerItem`
- `LUT_PiezometerPipeType`
- `LUT_SampleType`
- `GPHX_Geological`
- `GPHX_Backfill`
- `Rig`
- `DrillerLookup`
- `Grids`
- `Diameter`

Lookup table column names vary. Do not assume every lookup table has `VALUE`.

Examples:

- `LUT_HoleType` uses `VALUE`.
- `LUT_HoleStatus` uses `VALUE`.
- `Rig`, `DrillerLookup`, and `Grids` use `VALUE` and have `CLNT_ID`.
- `LUT_MoistureType` uses `TypeID`, `Description`, `Code`, and `ID`.
- `GPHX_Geological` uses `Value`, not `VALUE`.

## Remaining Build Plan

### Finish Phase 2 - POINT Editing

Needed:

- Add explicit edit workflow for existing CORE-GS `POINT` rows.
- Decide which optional fields the field team should own first.
- Keep validation against CORE-GS lookup/FK tables.

### Continue Phase 3 - Module Writes

Convert one module at a time:

- Geology -> `GEOLOGY` is started.
- SPT -> `SPT` is started.
- Core -> `Core`
- Backfill -> `Backfill`
- Water -> `Water`
- Installations -> `Piezometers_*`, possibly `Construction`
- Consumables -> likely `SiteRecords` plus `Consumables`

Each module should:

- Read existing CORE-GS rows for the active project/point.
- Use live lookup values.
- Validate natural keys before write.
- Upsert by natural unique key.
- Avoid touching fields the app does not own yet.
- Check `coregs_tables.xlsx` before implementation.

### Phase 4 - Offline Queue

Goal:

- Offline use remains possible without making Postgres a competing CORE-GS clone.

Pattern:

- IndexedDB stores local pending edits.
- API receives edits and either writes CORE-GS immediately or stores an app-owned queue entry in Postgres.
- Queue replay writes to CORE-GS using the same validation/upsert functions.
- UI clearly shows pending, synced, and failed states.

## Do Not Forget

- Check `coregs_tables.xlsx` before schema-sensitive changes.
- Do not hardcode seed-data assumptions into production behavior.
- Do not invent lookup values.
- Do not write `rts`.
- Do not reference columns unless verified for that specific table.
- Do not expose SQL Server credentials to the browser.
- Do not treat Postgres as the source of truth for CORE-GS business tables.
- Always scope with `CLNT_ID = Geotechnical`.
- Preserve exact CORE-GS table and column names, including odd spelling.
- Prefer small, table-specific API functions over one giant generic writer.
- Generic schema discovery is useful for inspection, but production writes should be explicit and constrained.
