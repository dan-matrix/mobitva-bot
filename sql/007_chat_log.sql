-- Выполнить один раз в Supabase → SQL Editor → New query → Run
-- Хранилище для сводки по проблемам из чата группы (включается админом командой /chatlog_on).

-- Настройки по группам: включено ли сохранение, нужна ли ежедневная сводка
create table if not exists chatlog_settings (
    chat_id bigint primary key,
    enabled boolean not null default false,
    auto_report boolean not null default false,
    last_report_date text,
    enabled_at timestamptz
);

-- Сообщения группы (только текст и внутренний номер отправителя, без имён). Автоматически чистятся ботом.
create table if not exists chat_log (
    chat_id bigint not null,
    message_id bigint not null,
    user_id bigint not null,
    text text not null,
    reply_to bigint,
    sent_at timestamptz not null,
    primary key (chat_id, message_id)
);

create index if not exists chat_log_chat_time_idx on chat_log (chat_id, sent_at);

-- ВАЖНО: включаем защиту строк без единой политики. Публичный anon-ключ (он лежит в коде бота)
-- тогда не сможет прочитать или изменить эти таблицы; бот работает через service_role и RLS обходит.
alter table chat_log enable row level security;
alter table chatlog_settings enable row level security;
