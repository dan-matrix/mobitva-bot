// ====================================================================
// Telegram-бот для Mobitva.help
//
// 1) Поиск: пишешь название предмета/руны/тотема и т.д. — бот ищет по
//    всей базе сразу, прощает опечатки.
// 2) Привязка аккаунта: /link КОД — привязывает Telegram к аккаунту
//    на сайте (код выдаётся в личном кабинете на сайте).
// 3) Таймеры: /timers, /timer_add, /timer_del, /timer_restart —
//    управление своими таймерами прямо из чата.
// 4) Уведомления: когда таймер истекает, бот сам пишет в личку.
//
// Работает в режиме webhook (Telegram сам стучится на наш сервер),
// чтобы бесплатный хостинг (Render) считал его обычным веб-сервисом.
// ====================================================================

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const Fuse = require('fuse.js');

// ---- Настройки (переменные окружения на хостинге) ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = 'https://gmcqxgxwtczjlwyifwew.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtY3F4Z3h3dGN6amx3eWlmd2V3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0MjIxMTAsImV4cCI6MjA5MDk5ODExMH0.cM6xm9qCRbl-c1h-pWOWKSeAozYUy7KpJjua79JgFuk';
const SITE_URL = 'https://mobitva.help';

if (!BOT_TOKEN) { console.error('! Не задана переменная окружения BOT_TOKEN.'); process.exit(1); }
if (!PUBLIC_URL) { console.error('! Не задана переменная окружения PUBLIC_URL.'); process.exit(1); }
if (!SERVICE_ROLE_KEY) { console.error('! Не задана переменная окружения SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

// Обычный клиент (анонимный ключ) — для поиска по общей базе.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: { transport: WebSocket },
    auth: { persistSession: false },
});

// Привилегированный клиент (service role) — обходит все ограничения доступа,
// нужен, чтобы читать/менять таймеры КОНКРЕТНЫХ пользователей. Держим
// только на сервере бота, никогда не показываем и не логируем целиком.
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

function logSendErr(e) { console.error('Ошибка отправки:', e.message); }

// ==================== ПОИСК ПО БАЗЕ ====================

const CATEGORIES = [
    { table: 'items', appPath: '/items/', param: 'id', label: '📦 Предмет' },
    { table: 'demons', appPath: '/demon/', param: 'id', label: '🛡️ Круг демона' },
    { table: 'totems', appPath: '/totem/', param: 'id', label: '🧪 Тотем' },
    { table: 'runes_master', appPath: '/master/', param: 'id', label: '✨ Руна мастера' },
    { table: 'runes_druids', appPath: '/druids/', param: 'id', label: '🌿 Руна друидов' },
    { table: 'nakolki', appPath: '/nakolki/', param: 'id', label: '🖋️ Наколка' },
    { table: 'enhancements', appPath: '/enhancements/', param: 'id', label: '✨ Усиление' },
    { table: 'secret_items_new', appPath: '/secret_items/', param: 'id', label: '🔮 Секретная вещь' },
    { table: 'secret_sets_new', appPath: '/secret_sets/', param: 'set', label: '👘 Секретный сет' },
    { table: 'secret_set_items_new', appPath: '/secret_sets/', param: 'set', label: '👘 Вещь из сета' },
];

let searchIndex = null;
let allEntries = [];
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

async function rebuildIndex() {
    const combined = [];
    for (const cat of CATEGORIES) {
        try {
            const { data, error } = await supabase.from(cat.table).select('*');
            if (error) { console.warn(`! Не удалось получить "${cat.table}":`, error.message); continue; }
            for (const row of data || []) combined.push({ ...row, __cat: cat });
        } catch (e) {
            console.warn(`! Ошибка при получении "${cat.table}":`, e.message);
        }
    }
    allEntries = combined;
    searchIndex = new Fuse(combined, {
        keys: ['name'],
        threshold: 0.4,
        ignoreLocation: true,
        minMatchCharLength: 2,
    });
    console.log(`Индекс поиска обновлён: ${combined.length} записей.`);
}

rebuildIndex().catch(e => console.error('Не удалось построить индекс при старте:', e.message));
setInterval(() => rebuildIndex().catch(e => console.error('Не удалось обновить индекс:', e.message)), REFRESH_INTERVAL_MS);

function formatEntry(row) {
    const cat = row.__cat;
    const lines = [];
    lines.push(`${cat.label}: ${row.name || `#${row.id}`}`);
    if (row.level !== undefined && row.level !== null) lines.push(`⭐ Уровень: ${row.level}`);
    if (row.stats && typeof row.stats === 'object') {
        const statsText = Object.entries(row.stats)
            .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
        if (statsText) lines.push(statsText);
    }
    if (row.description) {
        let desc = String(row.description);
        if (desc.length > 200) desc = desc.slice(0, 197) + '...';
        lines.push(desc);
    }
    const linkId = cat.param === 'set' ? (row.set_id ?? row.id) : row.id;
    lines.push(`🔗 ${SITE_URL}${cat.appPath}?${cat.param}=${linkId}&open=modal`);
    return lines.join('\n');
}

function fuzzySearch(query) {
    if (!searchIndex) return [];
    return searchIndex.search(query, { limit: 5 }).map(r => r.item);
}

async function handleSearch(chatId, query) {
    if (!query) return;
    try {
        if (!searchIndex) {
            bot.sendMessage(chatId, 'Секунду, ещё загружаю базу данных — попробуй написать ещё раз через пару секунд.').catch(logSendErr);
            return;
        }
        const normalizedQuery = query.trim().toLowerCase();
        const exactMatches = allEntries.filter(e => e.name && e.name.trim().toLowerCase() === normalizedQuery);

        if (exactMatches.length > 0) {
            const text = exactMatches.map(formatEntry).join('\n\n———\n\n');
            bot.sendMessage(chatId, text, { disable_web_page_preview: true }).catch(logSendErr);
            return;
        }

        const results = fuzzySearch(query);
        if (results.length === 0) {
            bot.sendMessage(chatId, `Такого нет: «${query}». Похожего тоже ничего не нашёл — попробуй сформулировать иначе.`).catch(logSendErr);
            return;
        }
        const text = `Точного совпадения с «${query}» нет, но вот похожее:\n\n` +
            results.map(formatEntry).join('\n\n———\n\n');
        bot.sendMessage(chatId, text, { disable_web_page_preview: true }).catch(logSendErr);
    } catch (e) {
        console.error('Ошибка обработки запроса:', e);
        bot.sendMessage(chatId, 'Что-то пошло не так при поиске. Попробуй ещё раз чуть позже.').catch(logSendErr);
    }
}

// ==================== ПРИВЯЗКА АККАУНТА ====================

async function getLinkedLogin(chatId) {
    const { data, error } = await supabaseAdmin
        .from('telegram_links')
        .select('login')
        .eq('telegram_chat_id', chatId)
        .eq('confirmed', true)
        .maybeSingle();
    if (error) { console.error('getLinkedLogin:', error.message); return null; }
    return data ? data.login : null;
}

async function requireLinkedLogin(chatId) {
    const login = await getLinkedLogin(chatId);
    if (!login) {
        bot.sendMessage(chatId, 'Сначала привяжи аккаунт: зайди в личный кабинет на сайте → раздел «✈️ Telegram-бот» → получи код → напиши мне /link КОД.').catch(logSendErr);
    }
    return login;
}

// ==================== ТАЙМЕРЫ ====================

async function getCharactersByLogin(login) {
    const { data, error } = await supabaseAdmin
        .from('user_characters')
        .select('*')
        .eq('user_id', login)
        .order('order_index', { ascending: true });
    if (error) { console.error('getCharactersByLogin:', error.message); return []; }
    return data || [];
}

async function getTimersForCharacter(characterId) {
    const { data, error } = await supabaseAdmin
        .from('user_timers')
        .select('*')
        .eq('character_id', characterId)
        .order('order_index', { ascending: true });
    if (error) { console.error('getTimersForCharacter:', error.message); return []; }
    return data || [];
}

async function getTimerWithAuth(timerId, login) {
    const { data: timer } = await supabaseAdmin.from('user_timers').select('*').eq('id', timerId).maybeSingle();
    if (!timer) return null;
    const { data: char } = await supabaseAdmin.from('user_characters').select('id, user_id').eq('id', timer.character_id).maybeSingle();
    if (!char || char.user_id !== login) return null;
    return timer;
}

function formatRemaining(endTimeMs) {
    const diff = endTimeMs - Date.now();
    if (diff <= 0) return 'истёк ⚠️';
    const totalMin = Math.floor(diff / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

// Состояние пошагового добавления таймера (/timer_add), по одному на чат
const timerAddState = new Map();

async function handleTimerAddStep(msg) {
    const state = timerAddState.get(msg.chat.id);
    const text = msg.text.trim();

    if (state.step === 'character') {
        const idx = parseInt(text) - 1;
        const chosen = state.characters[idx];
        if (!chosen) {
            bot.sendMessage(msg.chat.id, 'Не понял номер, напиши цифрой из списка ещё раз.').catch(logSendErr);
            return;
        }
        state.characterId = chosen.id;
        state.characterName = chosen.name;
        state.step = 'quest_name';
        timerAddState.set(msg.chat.id, state);
        bot.sendMessage(msg.chat.id, 'Напиши название квеста/таймера:', { reply_markup: { force_reply: true } }).catch(logSendErr);
        return;
    }

    if (state.step === 'quest_name') {
        state.questName = text;
        state.step = 'duration';
        timerAddState.set(msg.chat.id, state);
        bot.sendMessage(msg.chat.id, 'На сколько минут поставить таймер? (просто число)', { reply_markup: { force_reply: true } }).catch(logSendErr);
        return;
    }

    if (state.step === 'duration') {
        const minutes = parseInt(text.replace(/[^\d]/g, ''), 10);
        if (!minutes || minutes <= 0) {
            bot.sendMessage(msg.chat.id, 'Не понял число минут, напиши ещё раз просто цифрой, например: 90').catch(logSendErr);
            return;
        }
        const totalMs = minutes * 60 * 1000;
        const endTime = Date.now() + totalMs;

        const existingTimers = await getTimersForCharacter(state.characterId);
        const maxOrder = existingTimers.reduce((max, t) => Math.max(max, t.order_index || 0), 0);

        const { error } = await supabaseAdmin.from('user_timers').insert([{
            character_id: state.characterId,
            quest_name: state.questName,
            end_time: endTime,
            duration: totalMs,
            notes: '',
            is_active: true,
            order_index: maxOrder + 1,
        }]);
        timerAddState.delete(msg.chat.id);
        if (error) {
            console.error('Ошибка создания таймера:', error.message);
            bot.sendMessage(msg.chat.id, '❌ Не удалось создать таймер.').catch(logSendErr);
            return;
        }
        bot.sendMessage(msg.chat.id, `✅ Таймер «${state.questName}» на ${minutes} мин добавлен персонажу ${state.characterName}.`).catch(logSendErr);
    }
}

// ==================== ФОНОВАЯ ПРОВЕРКА ИСТЁКШИХ ТАЙМЕРОВ ====================

const NOTIFY_CHECK_INTERVAL_MS = 60 * 1000;

async function checkExpiredTimersAndNotify() {
    try {
        const { data: links, error } = await supabaseAdmin.from('telegram_links').select('*').eq('confirmed', true);
        if (error || !links) return;
        for (const link of links) {
            const characters = await getCharactersByLogin(link.login);
            for (const char of characters) {
                const timers = await getTimersForCharacter(char.id);
                for (const t of timers) {
                    if (!t.is_active) continue;
                    if (t.notified_at) continue;
                    if (t.end_time > Date.now()) continue;
                    await bot.sendMessage(link.telegram_chat_id, `⏰ Таймер «${t.quest_name}» (персонаж: ${char.name}) завершён!`)
                        .catch(e => console.error('Ошибка уведомления:', e.message));
                    await supabaseAdmin.from('user_timers').update({ notified_at: new Date().toISOString() }).eq('id', t.id);
                }
            }
        }
    } catch (e) {
        console.error('Ошибка проверки таймеров:', e.message);
    }
}

setTimeout(() => checkExpiredTimersAndNotify(), 15000);
setInterval(() => checkExpiredTimersAndNotify(), NOTIFY_CHECK_INTERVAL_MS);

// ==================== EXPRESS-СЕРВЕР ====================

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Mobitva bot is alive'));
app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, () => {
    console.log(`Сервер бота запущен на порту ${PORT}`);
    bot.setWebHook(`${PUBLIC_URL}/webhook`)
        .then(() => console.log('Webhook установлен:', `${PUBLIC_URL}/webhook`))
        .catch(err => console.error('Не удалось установить webhook:', err.message));
    bot.setMyCommands([
        { command: 'start', description: 'Помощь и как пользоваться ботом' },
        { command: 'item', description: 'Поиск: /item <название>' },
        { command: 'link', description: 'Привязать аккаунт сайта: /link КОД' },
        { command: 'unlink', description: 'Отвязать аккаунт сайта' },
        { command: 'timers', description: 'Список моих таймеров' },
        { command: 'timer_add', description: 'Добавить новый таймер' },
        { command: 'timer_del', description: 'Удалить таймер: /timer_del ID' },
        { command: 'timer_restart', description: 'Перезапустить таймер: /timer_restart ID' },
    ]).catch(err => console.error('Не удалось задать список команд:', err.message));
});

// ==================== КОМАНДЫ ====================

bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        'Привет! Я бот-справочник по игре МоБитва.\n\n' +
        '🔍 Поиск: просто напиши название предмета, руны, тотема и т.д.\n\n' +
        '✈️ Чтобы управлять таймерами прямо из чата, сначала привяжи аккаунт сайта:\n' +
        'зайди в личный кабинет на mobitva.help → раздел «Telegram-бот» → получи код → /link КОД\n\n' +
        'После привязки доступно:\n' +
        '/timers — список таймеров\n' +
        '/timer_add — добавить таймер\n' +
        '/timer_del ID — удалить\n' +
        '/timer_restart ID — перезапустить\n\n' +
        `Сайт: ${SITE_URL}`
    ).catch(logSendErr);
});

bot.onText(/^\/item(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const query = match[1] ? match[1].trim() : '';
    if (!query) {
        if (msg.chat.type === 'private') {
            bot.sendMessage(msg.chat.id, 'Что ищем? Напиши название предмета, руны, тотема и т.д. следующим сообщением:', {
                reply_markup: { force_reply: true }
            }).catch(logSendErr);
        } else {
            bot.sendMessage(msg.chat.id, 'В группе пиши сразу вместе с названием, например: /item меч огня').catch(logSendErr);
        }
        return;
    }
    await handleSearch(msg.chat.id, query);
});

bot.onText(/^\/link(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const code = match[1] ? match[1].trim().toUpperCase() : '';
    if (!code) {
        bot.sendMessage(msg.chat.id, 'Напиши код так: /link КОД (код показан в личном кабинете на сайте, в разделе «Telegram-бот»).').catch(logSendErr);
        return;
    }
    const { data, error } = await supabaseAdmin
        .from('telegram_links')
        .select('*')
        .eq('link_code', code)
        .eq('confirmed', false)
        .maybeSingle();

    if (error || !data) {
        bot.sendMessage(msg.chat.id, 'Код не найден или уже использован. Сгенерируй новый в личном кабинете на сайте.').catch(logSendErr);
        return;
    }

    const codeAgeMs = Date.now() - new Date(data.created_at).getTime();
    if (codeAgeMs > 30 * 60 * 1000) {
        bot.sendMessage(msg.chat.id, 'Этот код устарел. Сгенерируй новый в личном кабинете на сайте.').catch(logSendErr);
        return;
    }

    const { error: updateError } = await supabaseAdmin
        .from('telegram_links')
        .update({ telegram_chat_id: msg.chat.id, confirmed: true, confirmed_at: new Date().toISOString() })
        .eq('id', data.id);

    if (updateError) {
        bot.sendMessage(msg.chat.id, 'Не удалось привязать аккаунт. Попробуй ещё раз.').catch(logSendErr);
        return;
    }
    bot.sendMessage(msg.chat.id, `✅ Готово! Telegram привязан к аккаунту «${data.login}». Теперь доступны /timers, /timer_add, /timer_del, /timer_restart.`).catch(logSendErr);
});

bot.onText(/^\/unlink/, async (msg) => {
    const { error } = await supabaseAdmin.from('telegram_links').delete().eq('telegram_chat_id', msg.chat.id);
    bot.sendMessage(msg.chat.id, error ? 'Не удалось отвязать.' : '🔌 Telegram отвязан от аккаунта на сайте.').catch(logSendErr);
});

bot.onText(/^\/timers/, async (msg) => {
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;

    const characters = await getCharactersByLogin(login);
    if (characters.length === 0) {
        bot.sendMessage(msg.chat.id, 'У тебя пока нет персонажей на сайте. Создай персонажа в личном кабинете.').catch(logSendErr);
        return;
    }

    const lines = [];
    for (const char of characters) {
        const timers = await getTimersForCharacter(char.id);
        lines.push(`👤 ${char.name}`);
        if (timers.length === 0) {
            lines.push('   (нет таймеров)');
        } else {
            for (const t of timers) {
                const status = t.is_active ? formatRemaining(t.end_time) : 'на паузе';
                lines.push(`   #${t.id} ⏱️ ${t.quest_name} — ${status}`);
            }
        }
    }
    lines.push('', 'Команды: /timer_add, /timer_del ID, /timer_restart ID');
    bot.sendMessage(msg.chat.id, lines.join('\n')).catch(logSendErr);
});

bot.onText(/^\/timer_add/, async (msg) => {
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;

    const characters = await getCharactersByLogin(login);
    if (characters.length === 0) {
        bot.sendMessage(msg.chat.id, 'У тебя пока нет персонажей на сайте. Создай персонажа в личном кабинете.').catch(logSendErr);
        return;
    }

    if (characters.length === 1) {
        timerAddState.set(msg.chat.id, { step: 'quest_name', login, characterId: characters[0].id, characterName: characters[0].name });
        bot.sendMessage(msg.chat.id, `Персонаж: ${characters[0].name}\nНапиши название квеста/таймера:`, { reply_markup: { force_reply: true } }).catch(logSendErr);
    } else {
        const list = characters.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
        timerAddState.set(msg.chat.id, { step: 'character', login, characters });
        bot.sendMessage(msg.chat.id, `Выбери персонажа (напиши номер):\n${list}`, { reply_markup: { force_reply: true } }).catch(logSendErr);
    }
    setTimeout(() => timerAddState.delete(msg.chat.id), 5 * 60 * 1000);
});

bot.onText(/^\/timer_del(?:@\w+)?\s+(\d+)/, async (msg, match) => {
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;

    const timerId = parseInt(match[1], 10);
    const timer = await getTimerWithAuth(timerId, login);
    if (!timer) {
        bot.sendMessage(msg.chat.id, 'Таймер не найден или это не твой таймер.').catch(logSendErr);
        return;
    }
    const { error } = await supabaseAdmin.from('user_timers').delete().eq('id', timerId);
    bot.sendMessage(msg.chat.id, error ? '❌ Не удалось удалить.' : `🗑️ Таймер «${timer.quest_name}» удалён.`).catch(logSendErr);
});

bot.onText(/^\/timer_restart(?:@\w+)?\s+(\d+)/, async (msg, match) => {
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;

    const timerId = parseInt(match[1], 10);
    const timer = await getTimerWithAuth(timerId, login);
    if (!timer) {
        bot.sendMessage(msg.chat.id, 'Таймер не найден или это не твой таймер.').catch(logSendErr);
        return;
    }
    const newEndTime = Date.now() + timer.duration;
    const { error } = await supabaseAdmin
        .from('user_timers')
        .update({ end_time: newEndTime, is_active: true, notified_at: null })
        .eq('id', timerId);
    bot.sendMessage(msg.chat.id, error ? '❌ Не удалось перезапустить.' : `🔄 Таймер «${timer.quest_name}» перезапущен.`).catch(logSendErr);
});

// Любое обычное сообщение без команды — либо шаг мастера /timer_add,
// либо поиск (только в личных чатах с ботом).
bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    if (msg.chat.type !== 'private') return;

    if (timerAddState.has(msg.chat.id)) {
        await handleTimerAddStep(msg);
        return;
    }

    await handleSearch(msg.chat.id, msg.text.trim());
});
