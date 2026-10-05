-- Выполнить один раз в Supabase → SQL Editor → New query → Run

create table if not exists group_members (
    chat_id bigint not null,
    user_id bigint not null,
    user_name text not null,
    updated_at timestamptz not null default now(),
    primary key (chat_id, user_id)
);
