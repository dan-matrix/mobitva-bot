-- Выполнить один раз в Supabase → SQL Editor → New query → Run

create table if not exists whiner_settings (
    chat_id bigint primary key,
    enabled boolean not null default true
);
