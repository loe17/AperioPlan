-- 3D-Ansicht nativer CAD-Dateien (SolidWorks, Inventor, Solid Edge, CATIA …):
-- ein CAD-Arbeitsplatz wandelt die Datei auf Anfrage nach STEP um. Nur neue Tabelle, nichts wird geändert.
create table view_conversions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  version integer not null default 1,
  format text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  result_path text,
  error text,
  worker text,
  requested_by uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (file_id, version)
);
create index view_conversions_queue on view_conversions(status, requested_at);
