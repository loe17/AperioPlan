-- Version 1.2, Etappe 3: Gruppenchats, Reaktionen, Anrufverlauf mit Chat

alter table chat_channels drop constraint if exists chat_channels_kind_check;
alter table chat_channels add constraint chat_channels_kind_check check (kind in ('project', 'direct', 'team', 'group'));
alter table chat_channels add column icon text not null default 'chat', add column created_by uuid references users(id) on delete set null;

alter table chat_members add column role text not null default 'member' check (role in ('owner', 'member'));

-- Nachrichten während eines Anrufs gehören zum Anruf; der Verlaufseintrag eines Anrufs ist eine eigene Art
alter table chat_messages
  add column call_id uuid references calls(id) on delete set null,
  add column kind text not null default 'message' check (kind in ('message', 'call')),
  add column meta jsonb not null default '{}';
create index chat_messages_call on chat_messages(call_id) where call_id is not null;

create table message_reactions (
  message_id uuid not null references chat_messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table call_participants (
  call_id uuid not null references calls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (call_id, user_id, joined_at)
);
