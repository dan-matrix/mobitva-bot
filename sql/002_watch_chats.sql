-- Выполнить один раз в Supabase → SQL Editor → New query → Run

create table if not exists watch_chats (
    chat_id bigint primary key,
    added_at timestamptz not null default now()
);
