-- Lohnabrechnung: Personalstamm, Abrechnungsmonate, Lohnzettel

create table pay_employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references users(id) on delete set null,
  personnel_no text not null unique,
  first_name text not null default '',
  last_name text not null default '',
  birth_date date,
  street text not null default '',
  zip text not null default '',
  city text not null default '',
  email text not null default '',
  iban text not null default '',
  bic text not null default '',
  tax_id text not null default '',
  sv_number text not null default '',
  health_insurer text not null default '',
  job_title text not null default '',
  entry_date date,
  exit_date date,
  pay_type text not null default 'salary' check (pay_type in ('salary', 'hourly')),
  salary numeric(12,2) not null default 0,
  hourly_rate numeric(10,2) not null default 0,
  weekly_hours numeric(5,2) not null default 40,
  time_surcharges boolean not null default false,
  profile jsonb not null default '{}',
  recurring jsonb not null default '[]',
  cost_center text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pay_runs (
  id uuid primary key default gen_random_uuid(),
  year integer not null,
  month integer not null check (month between 1 and 12),
  status text not null default 'draft' check (status in ('draft', 'final')),
  finalized_at timestamptz,
  finalized_by uuid references users(id) on delete set null,
  exported_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (year, month)
);

create table pay_slips (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references pay_runs(id) on delete cascade,
  employee_id uuid not null references pay_employees(id) on delete cascade,
  lines jsonb not null default '[]',
  profile jsonb not null default '{}',
  result jsonb not null default '{}',
  gross numeric(12,2) not null default 0,
  net numeric(12,2) not null default 0,
  payout numeric(12,2) not null default 0,
  employer_cost numeric(12,2) not null default 0,
  pdf_path text,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (run_id, employee_id)
);
create index pay_slips_employee on pay_slips(employee_id);
