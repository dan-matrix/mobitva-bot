-- Выполнить один раз в Supabase → SQL Editor → New query → Run
-- Хранит, включены ли ИИ-ответы (/ask) в конкретной группе.

create table if not exists ai_settings (
    chat_id bigint primary key,
    enabled boolean not null default true
);
