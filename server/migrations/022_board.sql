-- Etappe 11e (0.2.0): Schwarzes Brett und interner Marktplatz

create table board_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  category text not null default 'Allgemein',
  author_id uuid references users(id) on delete set null,
  pinned boolean not null default false,
  important boolean not null default false,
  team_ids uuid[] not null default '{}',
  attachments jsonb not null default '[]',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index board_posts_time on board_posts (created_at desc);

create table board_reads (
  post_id uuid not null references board_posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  read_at timestamptz not null default now(),
  confirmed_at timestamptz,
  primary key (post_id, user_id)
);

create table board_likes (
  post_id uuid not null references board_posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (post_id, user_id)
);

create table market_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  category text not null default 'Sonstiges',
  condition text not null default 'used' check (condition in ('new', 'like_new', 'used', 'defect')),
  price numeric(12,2),
  price_type text not null default 'fixed' check (price_type in ('fixed', 'negotiable', 'free', 'offer')),
  company boolean not null default false,
  seller_id uuid references users(id) on delete cascade,
  location text not null default '',
  images jsonb not null default '[]',
  status text not null default 'available' check (status in ('available', 'reserved', 'sold')),
  reserved_for uuid references users(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index market_items_time on market_items (created_at desc);

create table market_watch (
  item_id uuid not null references market_items(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (item_id, user_id)
);
