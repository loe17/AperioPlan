-- Lager: Lagerorte, Artikel, Bestände (je Ort und Charge/Seriennummer), Bewegungen, Inventur
create table wh_locations (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references wh_locations(id) on delete restrict,
  name text not null,
  code text unique,                 -- für Barcode/QR-Etikett
  kind text not null default 'shelf' check (kind in ('warehouse', 'zone', 'shelf', 'bin')),
  active boolean not null default true,
  sort double precision not null default 0,
  created_at timestamptz not null default now()
);

create table wh_articles (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  name text not null,
  description text not null default '',
  category text not null default '',
  unit text not null default 'Stk',
  manufacturer text not null default '',
  manufacturer_no text not null default '',
  supplier_id uuid references crm_accounts(id) on delete set null,
  supplier_no text not null default '',
  purchase_price numeric(14,4),
  barcode text,
  min_qty numeric(14,3) not null default 0,
  reorder_qty numeric(14,3) not null default 0,
  tracking text not null default 'none' check (tracking in ('none', 'lot', 'serial')),
  default_location_id uuid references wh_locations(id) on delete set null,
  cad_item_id uuid references cad_items(id) on delete set null,
  image_path text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index wh_articles_barcode on wh_articles(barcode) where barcode is not null and barcode <> '';

create table wh_stock (
  article_id uuid not null references wh_articles(id) on delete cascade,
  location_id uuid not null references wh_locations(id) on delete restrict,
  lot text not null default '',     -- Charge oder Seriennummer
  qty numeric(14,3) not null default 0,
  primary key (article_id, location_id, lot)
);

create table wh_moves (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references wh_articles(id) on delete cascade,
  kind text not null check (kind in ('receipt', 'issue', 'transfer', 'adjust', 'return')),
  qty numeric(14,3) not null,
  from_location_id uuid references wh_locations(id) on delete set null,
  to_location_id uuid references wh_locations(id) on delete set null,
  lot text not null default '',
  project_id uuid references projects(id) on delete set null,
  purchase_item_id uuid references purchase_items(id) on delete set null,
  count_id uuid,
  unit_price numeric(14,4),
  note text not null default '',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index wh_moves_article on wh_moves(article_id, created_at desc);
create index wh_moves_project on wh_moves(project_id) where project_id is not null;

create table wh_counts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_id uuid references wh_locations(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create table wh_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references wh_counts(id) on delete cascade,
  article_id uuid not null references wh_articles(id) on delete cascade,
  location_id uuid not null references wh_locations(id) on delete cascade,
  lot text not null default '',
  expected numeric(14,3) not null default 0,
  counted numeric(14,3),
  counted_by uuid references users(id) on delete set null,
  counted_at timestamptz,
  unique (count_id, article_id, location_id, lot)
);

-- Einkauf kennt den Lagerartikel (Nachbestellung, Wareneingang ins Lager)
alter table purchase_items add column wh_article_id uuid references wh_articles(id) on delete set null;

-- Inventar: Geräte, Maschinen, Ausstattung
create table inv_assets (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  name text not null,
  category text not null default '',
  manufacturer text not null default '',
  model text not null default '',
  serial_no text not null default '',
  location text not null default '',
  holder_id uuid references users(id) on delete set null,
  team_id uuid references teams(id) on delete set null,
  resource_id uuid references resources(id) on delete set null,
  supplier_id uuid references crm_accounts(id) on delete set null,
  purchase_date date,
  purchase_price numeric(14,2),
  warranty_until date,
  depreciation_years numeric(5,2),
  status text not null default 'active' check (status in ('active', 'repair', 'retired', 'lost')),
  retired_at date,
  notes text not null default '',
  image_path text,
  attachments jsonb not null default '[]',
  last_seen_at timestamptz,
  last_seen_by uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inv_assets_holder on inv_assets(holder_id);

create table inv_inspections (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references inv_assets(id) on delete cascade,
  kind text not null,
  interval_months integer not null default 12,
  last_date date,
  next_date date,
  responsible_id uuid references users(id) on delete set null,
  notes text not null default '',
  reminded_for date
);
create index inv_inspections_next on inv_inspections(next_date);

create table inv_inspection_log (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inv_inspections(id) on delete cascade,
  date date not null,
  result text not null check (result in ('ok', 'defect', 'failed')),
  notes text not null default '',
  attachments jsonb not null default '[]',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table inv_handovers (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references inv_assets(id) on delete cascade,
  from_user_id uuid references users(id) on delete set null,
  to_user_id uuid references users(id) on delete set null,
  date date not null default current_date,
  note text not null default '',
  confirmed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
