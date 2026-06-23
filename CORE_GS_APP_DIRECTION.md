# SubStrata Field and CORE-GS Direction

Last updated: 2026-06-23

## Current Decision

SubStrata Field should not be rebuilt from scratch.

The existing app shell is still useful:

- Field auth and session handling
- Mobile/PWA install behavior
- Bottom module navigation
- IndexedDB local cache and pending-sync pattern
- Existing field-entry screens
- Node API bridge
- Postgres database for app-owned auth/cache/queue data
- MSSQL connection to CORE-GS

The part that needs to change is the data model underneath the app. The early seed data was useful for prototyping, but it contains assumptions that conflict with the real CORE-GS schema and lookup values. Going forward, CORE-GS is the source of truth for projects, points, lookup values, and production field records.

## Architecture Direction

The mobile app should not talk to SQL Server directly.

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

CORE-GS remains authoritative. Postgres and IndexedDB are support layers, not competing source-of-truth databases for CORE-GS business data.

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

The API health response confirmed:

- CORE-GS bridge enabled
- CORE-GS configured
- SQL Server reachable
- Login authenticated as `api.qgis`
- Database is `CORE-GS-TEST`
- Server is `DRILLING-PC08\SQLSTANDARD2019`

## Important Current Code State

The app has already started pivoting to CORE-GS:

- `/api/projects` reads from `dbo.PROJECT` when CORE-GS is enabled.
- `/api/points?proj_id=...` reads from `dbo.POINT` when CORE-GS is enabled.
- `/api/lookups/hole-types` reads from `dbo.LUT_HoleType`.
- Jobs tab button now says `Refresh from CORE-GS`.
- The obsolete UI card for pushing seeded projects/points to CORE-GS was removed.
- Explicit hole-type remapping such as `BH -> RC` was removed.
- New point type choices are loaded from CORE-GS lookup values.
- Service worker cache was bumped to `substrata-v17`.

There are also protected schema-discovery endpoints:

```text
GET /api/core-gs/schema/tables
GET /api/core-gs/schema/tables?search=POINT
GET /api/core-gs/schema/table?schema=dbo&table=POINT
GET /api/core-gs/schema/table?schema=dbo&table=POINT&sample=10
GET /api/core-gs/lookups
GET /api/core-gs/lookup-values?schema=dbo&table=LUT_HoleType
```

These endpoints are for authenticated users only.

## Workbook Evidence

The file below contains live SSMS exports from CORE-GS:

```text
C:\Users\SeanTempleton\OneDrive - McMillan Drilling Ltd\Work\Coding\coregs_tables.xlsx
```

It contains five sheets:

- `coregs_tables`
- `coregs_columns`
- `coregs_foreignkeys`
- `coregs_indexes`
- `coregs_lookups`

Observed counts:

- 135 tables
- 1,462 columns
- 356 foreign-key rows
- 591 index rows
- 133,141 lookup/value rows
- 41 lookup-like tables

This workbook is the best current snapshot for planning app behavior.

## Critical CORE-GS Rules

### Client Scope

Always scope CORE-GS reads and writes by:

```text
CLNT_ID = Geotechnical
```

This is not optional.

### Primary Key Pattern

Most CORE-GS tables use:

```text
GEO_ID uniqueidentifier default newid()
```

as the physical primary key.

The app should normally not generate or depend on `GEO_ID` for idempotent writes unless there is a specific reason. Use the table's natural unique keys for upsert behavior.

### Rowversion

Many tables contain:

```text
rts timestamp
```

This is SQL Server `timestamp` / `rowversion`. The app should not insert or update `rts`. SQL Server generates it.

If a required-column scan says `rts` is required, ignore that for app input design.

### Lookup and Foreign Key Values

Do not invent lookup values.

If a field is backed by a lookup or FK table, the UI should read the valid values from CORE-GS and submit the actual lookup code. Avoid hardcoded mappings unless they are documented business rules.

Example failure already seen:

- App tried to write `POINT.Type = BH`.
- CORE-GS rejected it because `BH` is not in `dbo.LUT_HoleType.VALUE`.
- Correct fix is not to map blindly. Correct fix is to make the UI use real `LUT_HoleType` values.

## Natural Keys and Major Tables

Use these keys for idempotent read/update behavior.

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

Foreign keys:

- `CLNT_ID -> _clnt.CLNT_ID`
- `CLNT_ID, Client -> Clients.CLNT_ID, Clients.CLIENT_ID`

Important caution:

- `PROJECT.Client` must match an existing `Clients.CLIENT_ID` for the same `CLNT_ID`.

### POINT

Table: `dbo.POINT`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID
```

Important columns:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `Type`
- `HoleDepth`
- `Location`
- `Remarks`
- `StartDate`
- `EndDate`
- `LoggedBy`
- `Driller`
- `Rig`
- `Status`

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

Important required app fields:

- `CLNT_ID`
- `PROJ_ID`
- `POINT_ID`
- `TOP`
- `BASE`

Important lookup/FK fields include:

- `Legend -> GPHX_Geological.Value`
- `ConsistencyDensity -> LUT_ConsistencyDensityType.TypeID`
- `MoistureCondition -> LUT_MoistureType.TypeID`
- `SoilClassification -> LUT_USCType.TypeID`

### SPT

Table: `dbo.SPT`

Natural unique key:

```text
CLNT_ID, PROJ_ID, POINT_ID, TOP
```

Important lookup:

- `Type -> LUT_SptType.Value`

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

Examples:

`LUT_HoleType` contains values such as:

- `RC`: Rotary cored
- `RO`: Rotary open hole
- `CP`: Cable percussion
- `SCP`: Static cone penetrometer
- `TP`: Trial pit/trench
- `WS`: Window sampler
- `HA`: Hand auger

`LUT_SptType` contains:

- `C`: Solid 60 degree cone
- `S`: Raymond Split Spoon

`GPHX_Backfill` contains:

- `CEMENT`
- `FSAND`
- `TOPSOIL`
- `BENTONITE`
- `ARISINGS`
- `SAND`
- `BSAND`
- `ASPHALT`
- `GROUT`
- `GRAVEL`
- `!CONC`
- `COLLAPSE`

## Recommended Build Plan

### Phase 1 - Stabilize CORE-GS Reads

Goal:

- Make project and point selection fully CORE-GS-backed.

Tasks:

- Keep `/api/projects` reading `PROJECT`.
- Keep `/api/points` reading `POINT`.
- Add generic lookup endpoint usage in the frontend.
- Remove production reliance on `api-data.json` seed project/point data.
- Keep sample data only as local demo fallback if explicitly needed.

### Phase 2 - Point Editing

Goal:

- Let users create or edit `POINT` rows using real CORE-GS constraints.

Tasks:

- Use `LUT_HoleType` for `POINT.Type`.
- Use `LUT_HoleStatus` for `POINT.Status`.
- Use `Rig`, `DrillerLookup`, `Grids`, and relevant lookup tables for constrained fields.
- Write through API to CORE-GS.
- Store pending offline point edits in IndexedDB and Postgres queue.

### Phase 3 - Module-by-Module Writes

Convert one module at a time:

- Geology -> `GEOLOGY`
- SPT -> `SPT`
- Core -> `Core`
- Backfill -> `Backfill`
- Water -> `Water`
- Installations -> `Piezometers_*`, possibly `Construction`
- Consumables -> likely `SiteRecords` plus `Consumables`

Each module should:

- Read existing CORE-GS rows for the active project/point.
- Use live lookup values.
- Validate natural keys before write.
- Upsert by the natural unique key.
- Avoid touching fields the app does not own yet.

### Phase 4 - Offline Queue

Goal:

- Offline use remains possible, but without making Postgres a competing CORE-GS clone.

Pattern:

- IndexedDB stores local pending edits.
- API receives edits and either writes CORE-GS immediately or stores an app-owned queue entry in Postgres.
- Queue replay writes to CORE-GS using the same validation/upsert functions.
- UI clearly shows pending, synced, and failed states.

## Do Not Forget

- Do not hardcode seed-data assumptions into production behavior.
- Do not invent lookup values.
- Do not write `rts`.
- Do not expose SQL Server credentials to the browser.
- Do not treat Postgres as the source of truth for CORE-GS business tables.
- Always scope with `CLNT_ID = Geotechnical`.
- Preserve exact CORE-GS table and column names, including odd spelling.
- Prefer small, table-specific API functions over one giant generic writer.
- Generic schema discovery is useful for inspection, but production writes should be explicit and constrained.

