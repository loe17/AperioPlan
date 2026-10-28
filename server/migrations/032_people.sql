-- Personal & Organisation: Spesen, Einsatzplanung, Personal (Akte, Gespräche, Qualifikationen, Bewerbungen), Unterweisungen, Fuhrpark

create table exp_reports (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  purpose text not null default '',
  destination text not null default '',
  country text not null default 'DE',
  start_at timestamptz,
  end_at timestamptz,
  meals jsonb not null default '{}',
  project_id uuid references projects(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'paid')),
  approver_id uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index exp_reports_user on exp_reports(user_id, created_at desc);

create table exp_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references exp_reports(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('receipt', 'mileage', 'lodging', 'travel', 'other')),
  category text not null default '',
  description text not null default '',
  amount numeric(12,2) not null default 0,
  vat_rate numeric(5,2) not null default 19,
  km numeric(10,1),
  paid_by text not null default 'self' check (paid_by in ('self', 'company')),
  receipt_path text,
  receipt_name text,
  created_at timestamptz not null default now()
);

create table plan_shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  role text not null default '',
  location text not null default '',
  color text not null default '',
  project_id uuid references projects(id) on delete set null,
  note text not null default '',
  published boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index plan_shifts_date on plan_shifts(date);
create index plan_shifts_user on plan_shifts(user_id, date);

create table plan_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_time time not null,
  end_time time not null,
  role text not null default '',
  color text not null default '#4f46e5'
);

create table hr_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  category text not null default 'Sonstiges',
  title text not null,
  file_path text not null,
  file_name text not null,
  valid_until date,
  visible_to_employee boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table hr_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  kind text not null default 'annual',
  notes text not null default '',
  goals jsonb not null default '[]',
  shared boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hr_skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null default '',
  needs_certificate boolean not null default false
);

create table hr_user_skills (
  user_id uuid not null references users(id) on delete cascade,
  skill_id uuid not null references hr_skills(id) on delete cascade,
  level integer not null default 2 check (level between 1 and 4),
  valid_until date,
  note text not null default '',
  certificate_path text,
  certificate_name text,
  updated_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);

create table hr_jobs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  location text not null default '',
  hours text not null default '',
  status text not null default 'open' check (status in ('draft', 'open', 'closed')),
  public_token text not null unique,
  owner_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table hr_applicants (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references hr_jobs(id) on delete set null,
  name text not null,
  email text not null default '',
  phone text not null default '',
  stage text not null default 'new' check (stage in ('new', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  rating integer not null default 0,
  notes text not null default '',
  message text not null default '',
  files jsonb not null default '[]',
  delete_after date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trn_courses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  content text not null default '',
  kind text not null default 'instruction' check (kind in ('instruction', 'training')),
  interval_months integer,
  audience jsonb not null default '{"all": true, "teamIds": [], "userIds": []}',
  quiz jsonb not null default '[]',
  pass_score integer not null default 80,
  files jsonb not null default '[]',
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trn_records (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references trn_courses(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  completed_at timestamptz not null default now(),
  valid_until date,
  score integer,
  method text not null default 'online' check (method in ('online', 'presence')),
  trainer text not null default '',
  confirmed_by uuid references users(id) on delete set null,
  note text not null default ''
);
create index trn_records_user on trn_records(user_id, course_id, completed_at desc);

create table trn_reminders (
  course_id uuid not null references trn_courses(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  due date not null,
  primary key (course_id, user_id, due)
);

create table fl_vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null unique,
  make text not null default '',
  model text not null default '',
  vin text not null default '',
  kind text not null default 'car' check (kind in ('car', 'van', 'truck', 'trailer', 'other')),
  fuel text not null default 'diesel',
  first_registration date,
  list_price numeric(12,2),
  ownership text not null default 'owned' check (ownership in ('owned', 'leased', 'rented')),
  leasing_end date,
  leasing_rate numeric(10,2),
  driver_id uuid references users(id) on delete set null,
  private_use boolean not null default false,
  resource_id uuid references resources(id) on delete set null,
  mileage integer not null default 0,
  next_hu date,
  next_service date,
  service_km integer,
  insurance text not null default '',
  notes text not null default '',
  active boolean not null default true,
  reminded jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table fl_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references fl_vehicles(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('fuel', 'charge', 'service', 'repair', 'tires', 'insurance', 'tax', 'leasing', 'other')),
  amount numeric(12,2) not null default 0,
  liters numeric(10,2),
  mileage integer,
  note text not null default '',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table fl_trips (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references fl_vehicles(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  date date not null,
  start_km integer not null,
  end_km integer not null check (end_km >= start_km),
  origin text not null default '',
  destination text not null default '',
  purpose text not null default '',
  partner text not null default '',
  kind text not null default 'business' check (kind in ('business', 'private', 'commute')),
  created_at timestamptz not null default now()
);
create index fl_trips_vehicle on fl_trips(vehicle_id, date);

create table fl_damages (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references fl_vehicles(id) on delete cascade,
  date date not null,
  description text not null,
  status text not null default 'open' check (status in ('open', 'repaired', 'closed')),
  cost numeric(12,2),
  reported_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table fl_license_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  classes text not null default '',
  checked_by uuid references users(id) on delete set null,
  note text not null default ''
);
