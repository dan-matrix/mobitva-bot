-- Выполнить один раз в Supabase → SQL Editor → New query → Run

create table if not exists daily_whiner (
    chat_id bigint primary key,
    date text not null,
    user_id bigint not null,
    user_name text not null
);
