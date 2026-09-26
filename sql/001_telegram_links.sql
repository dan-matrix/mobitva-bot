-- Выполнить один раз в Supabase → SQL Editor → New query → Run

-- Таблица связки аккаунта на сайте с чатом в Телеграме
create table if not exists telegram_links (
    id bigint generated always as identity primary key,
    login text not null,
    link_code text,
    telegram_chat_id bigint,
    confirmed boolean not null default false,
    created_at timestamptz not null default now(),
    confirmed_at timestamptz
);

create index if not exists telegram_links_login_idx on telegram_links (login);
create unique index if not exists telegram_links_code_idx on telegram_links (link_code) where confirmed = false;
create index if not exists telegram_links_chat_idx on telegram_links (telegram_chat_id) where confirmed = true;

-- Отметка "уже отправили уведомление об истечении" — чтобы бот не слал
-- одно и то же сообщение повторно при каждой проверке
alter table user_timers add column if not exists notified_at timestamptz;
