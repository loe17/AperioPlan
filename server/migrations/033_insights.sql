-- Freigaben, E-Signatur, Auswertungen, Eigene Felder, Nachhaltigkeit

-- ---------------------------------------------------------------- Freigaben (allgemeine Anträge)
create table apr_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  icon text not null default 'approve',
  fields jsonb not null default '[]',        -- [{id, label, type, options, required}]
  steps jsonb not null default '[]',         -- [{kind: lead|users|admin, userIds, minAmount, all}]
  amount_field text,                         -- Feld, das den Betrag für Wertgrenzen liefert
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create table apr_requests (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  type_id uuid not null references apr_types(id) on delete restrict,
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  data jsonb not null default '{}',
  amount numeric(14,2),
  project_id uuid references projects(id) on delete set null,
  files jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  step integer not null default 0,
  steps jsonb not null default '[]',         -- beim Einreichen festgelegte Stufen mit Genehmigern
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index apr_requests_user on apr_requests(user_id, created_at desc);
create index apr_requests_status on apr_requests(status);

create table apr_decisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references apr_requests(id) on delete cascade,
  step integer not null,
  user_id uuid not null references users(id) on delete cascade,
  approve boolean not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (request_id, step, user_id)
);

insert into apr_types (name, description, icon, fields, steps, amount_field, sort) values
  ('Anschaffung', 'Bestellanforderung für Werkzeug, Material, Software oder Geräte', 'box',
   '[{"id":"item","label":"Was soll angeschafft werden?","type":"text","required":true},{"id":"reason","label":"Begründung","type":"textarea","required":true},{"id":"amount","label":"Kosten (netto)","type":"money","required":true},{"id":"supplier","label":"Lieferant / Link","type":"text"}]',
   '[{"kind":"lead","userIds":[],"minAmount":null,"all":false},{"kind":"admin","userIds":[],"minAmount":1000,"all":false}]', 'amount', 1),
  ('Weiterbildung', 'Kurs, Seminar, Messe oder Zertifizierung', 'graduation',
   '[{"id":"course","label":"Weiterbildung","type":"text","required":true},{"id":"provider","label":"Anbieter","type":"text"},{"id":"date","label":"Termin","type":"date"},{"id":"amount","label":"Kosten","type":"money"},{"id":"reason","label":"Nutzen für die Arbeit","type":"textarea"}]',
   '[{"kind":"lead","userIds":[],"minAmount":null,"all":false}]', 'amount', 2),
  ('Allgemeiner Antrag', 'Alles andere, das jemand genehmigen muss', 'approve',
   '[{"id":"text","label":"Worum geht es?","type":"textarea","required":true}]',
   '[{"kind":"lead","userIds":[],"minAmount":null,"all":false}]', null, 3);

-- ---------------------------------------------------------------- E-Signatur
create table sig_envelopes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  title text not null,
  message text not null default '',
  file_path text not null,
  file_name text not null,
  sha256 text not null,
  sequential boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'sent', 'completed', 'declined', 'cancelled', 'expired')),
  expires_at date,
  project_id uuid references projects(id) on delete set null,
  account_id uuid references crm_accounts(id) on delete set null,
  protocol_path text,
  created_by uuid references users(id) on delete set null,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sig_signers (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references sig_envelopes(id) on delete cascade,
  sort integer not null default 0,
  name text not null,
  email text not null,
  user_id uuid references users(id) on delete set null,
  token text not null unique,
  status text not null default 'pending' check (status in ('pending', 'signed', 'declined')),
  invited_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  signature jsonb,                -- {strokes, aspect}
  typed_name text not null default '',
  ip text not null default '',
  user_agent text not null default '',
  decline_reason text not null default '',
  reminded_at timestamptz
);
create index sig_signers_env on sig_signers(envelope_id, sort);

-- ---------------------------------------------------------------- Auswertungen
create table bi_reports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  def jsonb not null,             -- {source, dim, dim2, measure, period, chart}
  owner_id uuid references users(id) on delete cascade,
  shared boolean not null default false,
  pinned boolean not null default false,
  sort double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Eigene Felder
create table cf_fields (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('project', 'crm_account', 'crm_contact', 'article', 'asset', 'ticket', 'service_job')),
  key text not null,
  label text not null,
  type text not null check (type in ('text', 'textarea', 'number', 'money', 'date', 'select', 'multiselect', 'checkbox', 'url', 'user')),
  options jsonb not null default '[]',
  required boolean not null default false,
  help text not null default '',
  sort double precision not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (entity, key)
);

create table cf_values (
  entity text not null,
  entity_id uuid not null,
  "values" jsonb not null default '{}',
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (entity, entity_id)
);

-- ---------------------------------------------------------------- Nachhaltigkeit
create table sus_factors (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  unit text not null,
  kg_per_unit numeric(12,5) not null,
  scope integer not null check (scope in (1, 2, 3)),
  category text not null,
  source text not null default '',
  active boolean not null default true,
  sort integer not null default 0
);

insert into sus_factors (key, label, unit, kg_per_unit, scope, category, source, sort) values
  ('electricity', 'Strom (Netzbezug, Strommix Deutschland)', 'kWh', 0.353, 2, 'Strom', 'Umweltbundesamt, Strommix 2024 (vorläufig): 353 g/kWh', 1),
  ('electricity_green', 'Ökostrom (Herkunftsnachweis)', 'kWh', 0, 2, 'Strom', 'marktbasiert mit Herkunftsnachweis', 2),
  ('gas', 'Erdgas', 'kWh', 0.201, 1, 'Wärme', 'BAFA/KfW-Infoblatt CO2-Faktoren (Stand 10/2024): 0,201 t/MWh', 3),
  ('heating_oil', 'Heizöl', 'Liter', 2.66, 1, 'Wärme', 'BAFA/KfW-Infoblatt CO2-Faktoren: 0,00266 t/l', 4),
  ('lpg', 'Flüssiggas', 'kWh', 0.239, 1, 'Wärme', 'BAFA/KfW-Infoblatt CO2-Faktoren: 0,239 t/MWh', 5),
  ('district_heat', 'Fernwärme', 'kWh', 0.280, 2, 'Wärme', 'BAFA/KfW-Infoblatt CO2-Faktoren: 0,280 t/MWh', 6),
  ('diesel', 'Diesel (Firmenfahrzeuge)', 'Liter', 2.66, 1, 'Fuhrpark', 'BAFA/KfW-Infoblatt CO2-Faktoren: Heizöl leicht/Diesel 0,00266 t/l', 7),
  ('petrol', 'Benzin (Firmenfahrzeuge)', 'Liter', 2.35, 1, 'Fuhrpark', 'BAFA/KfW-Infoblatt CO2-Faktoren: 0,0023496 t/l', 8),
  ('car_km', 'Dienstfahrt mit Privat-Pkw', 'km', 0.164, 3, 'Geschäftsreisen', 'Umweltbundesamt TREMOD, Pkw 2024: 164 g/Pkm', 9),
  ('train_km', 'Bahn Fernverkehr', 'km', 0.026, 3, 'Geschäftsreisen', 'Umweltbundesamt TREMOD, Fernverkehr 2024: 26 g/Pkm', 10),
  ('flight_km', 'Flug Inland', 'km', 0.290, 3, 'Geschäftsreisen', 'Umweltbundesamt TREMOD, Flug Inland 2024: 290 g/Pkm', 11);

create table sus_entries (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  period_end date,
  factor_id uuid not null references sus_factors(id) on delete restrict,
  quantity numeric(14,3) not null,
  project_id uuid references projects(id) on delete set null,
  site text not null default '',
  note text not null default '',
  origin text not null default 'manual' check (origin in ('manual', 'fleet', 'expenses')),
  origin_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index sus_entries_origin on sus_entries(origin, origin_id) where origin_id is not null;
create index sus_entries_date on sus_entries(date);
