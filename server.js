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

let sharp = null;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn('! Модуль "sharp" недоступен — иконки в ответах поиска показываться не будут.');
}

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

function requirePrivateChat(msg) {
    if (msg.chat.type !== 'private') {
        bot.sendMessage(msg.chat.id, '🔒 Управление таймерами работает только в личных сообщениях боту — напиши мне в личку.').catch(logSendErr);
        return false;
    }
    return true;
}

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

// ---- Иконки предметов: вырезаем нужный кусок из общего спрайта сайта ----
const SPRITE_URL = `${SITE_URL}/img/shopico.png`;
const SPRITE_CELL = 180;
let spriteBufferCache = null;

async function getSpriteBuffer() {
    if (spriteBufferCache) return spriteBufferCache;
    try {
        const res = await fetch(SPRITE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        spriteBufferCache = Buffer.from(await res.arrayBuffer());
        return spriteBufferCache;
    } catch (e) {
        console.warn('! Не удалось загрузить спрайт иконок:', e.message);
        return null;
    }
}

async function getEntryIconBuffer(row) {
    if (!sharp) return null;
    if (row.icon_row === undefined || row.icon_row === null || row.icon_col === undefined || row.icon_col === null) return null;
    const sprite = await getSpriteBuffer();
    if (!sprite) return null;
    try {
        return await sharp(sprite)
            .extract({
                left: Number(row.icon_col) * SPRITE_CELL,
                top: Number(row.icon_row) * SPRITE_CELL,
                width: SPRITE_CELL,
                height: SPRITE_CELL,
            })
            .png()
            .toBuffer();
    } catch (e) {
        console.warn('! Не удалось вырезать иконку:', e.message);
        return null;
    }
}

function formatEntry(row) {
    const cat = row.__cat;
    const blocks = [];
    blocks.push(`${cat.label}: ${row.name || `#${row.id}`}`);
    if (row.level !== undefined && row.level !== null) blocks.push(`⭐ Уровень: ${row.level}`);

    if (row.stats && typeof row.stats === 'object') {
        const statLines = Object.entries(row.stats)
            .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
            .map(([k, v]) => `• ${k}: ${v}`);
        if (statLines.length) blocks.push(statLines.join('\n'));
    }

    if (Array.isArray(row.unique_stats) && row.unique_stats.length > 0) {
        blocks.push('✨ Уникальные характеристики:\n' + row.unique_stats.map(u => `• ${u}`).join('\n'));
    }

    if (row.description) {
        let desc = String(row.description);
        if (desc.length > 200) desc = desc.slice(0, 197) + '...';
        blocks.push(desc);
    }

    const linkId = cat.param === 'set' ? (row.set_id ?? row.id) : row.id;
    blocks.push(`🔗 ${SITE_URL}${cat.appPath}?${cat.param}=${linkId}&open=modal`);

    let text = blocks.join('\n\n');
    if (text.length > 1000) text = text.slice(0, 997) + '...';
    return text;
}

async function sendEntryResult(chatId, row) {
    const caption = formatEntry(row);
    const iconBuffer = await getEntryIconBuffer(row);
    if (iconBuffer) {
        await bot.sendPhoto(chatId, iconBuffer, { caption }).catch(logSendErr);
    } else {
        await bot.sendMessage(chatId, caption, { disable_web_page_preview: true }).catch(logSendErr);
    }
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
            for (const row of exactMatches) await sendEntryResult(chatId, row);
            return;
        }

        const results = fuzzySearch(query);
        if (results.length === 0) {
            bot.sendMessage(chatId, `Такого нет: «${query}». Похожего тоже ничего не нашёл — попробуй сформулировать иначе.`).catch(logSendErr);
            return;
        }
        await bot.sendMessage(chatId, `Точного совпадения с «${query}» нет, но вот похожее:`).catch(logSendErr);
        for (const row of results) await sendEntryResult(chatId, row);
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
    if (diff <= 0) return 'истёк';
    const totalMin = Math.floor(diff / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

// Цветной индикатор срочности: 🟢 много времени, 🟡 меньше часа,
// 🟠 меньше 10 минут, 🔴 истёк, ⏸️ на паузе
function statusEmoji(timer) {
    if (!timer.is_active) return '⏸️';
    const diff = timer.end_time - Date.now();
    if (diff <= 0) return '🔴';
    const min = diff / 60000;
    if (min <= 10) return '🟠';
    if (min <= 60) return '🟡';
    return '🟢';
}

// Самый "тревожный" статус среди таймеров персонажа — чтобы показать
// его прямо на кнопке со списком персонажей, не открывая таймеры
function worstStatus(timers) {
    if (timers.length === 0) return '⚪';
    const priority = ['🔴', '🟠', '🟡', '⏸️', '🟢'];
    const present = new Set(timers.map(statusEmoji));
    for (const s of priority) if (present.has(s)) return s;
    return '⚪';
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Экран 1: список персонажей с общим индикатором срочности
async function buildCharactersView(login) {
    const characters = await getCharactersByLogin(login);
    if (characters.length === 0) {
        return {
            text: 'У тебя пока нет персонажей. Создай первого:',
            keyboard: { inline_keyboard: [[{ text: '➕ Создать персонажа', callback_data: 'cn' }]] },
        };
    }

    const buttons = [];
    for (const char of characters) {
        const timers = await getTimersForCharacter(char.id);
        const status = worstStatus(timers);
        const label = timers.length > 0
            ? `${status} ${char.name} (${timers.length})`
            : `⚪ ${char.name} (нет таймеров)`;
        buttons.push([{ text: label, callback_data: `tc:${char.id}` }]);
    }
    buttons.push([
        { text: '➕ Добавить таймер', callback_data: 'add' },
        { text: '👤 Новый персонаж', callback_data: 'cn' },
    ]);

    return {
        text: '👤 <b>Выбери персонажа:</b>\n\n🟢 много времени · 🟡 меньше часа · 🟠 скоро истечёт · 🔴 истёк · ⏸️ на паузе',
        keyboard: { inline_keyboard: buttons },
    };
}

// Экран 2: таймеры одного персонажа
async function buildCharacterTimersView(login, characterId) {
    const characters = await getCharactersByLogin(login);
    const char = characters.find(c => c.id === characterId);
    if (!char) return { text: 'Персонаж не найден.', keyboard: null };

    const timers = await getTimersForCharacter(characterId);
    const buttons = [];

    if (timers.length === 0) {
        buttons.push([{ text: '➕ Добавить таймер', callback_data: 'add' }]);
    } else {
        for (const t of timers) {
            const status = statusEmoji(t);
            const remaining = t.is_active ? formatRemaining(t.end_time) : 'на паузе';
            buttons.push([{ text: `${status} ${t.quest_name} — ${remaining}`, callback_data: `tl:${t.id}` }]);
        }
    }
    buttons.push([{ text: '⬅️ Назад к персонажам', callback_data: 'tb' }]);

    const text = timers.length > 0
        ? `👤 <b>${escapeHtml(char.name)}</b> — таймеры:`
        : `👤 <b>${escapeHtml(char.name)}</b>\nТаймеров пока нет.`;

    return { text, keyboard: { inline_keyboard: buttons } };
}

// Готовые варианты длительности: минуты, часы, дни. В callback_data всегда
// хранятся МИНУТЫ (число), подпись на кнопке — человекочитаемая.
const DURATION_PRESETS = [
    { label: '15 мин', minutes: 15 },
    { label: '30 мин', minutes: 30 },
    { label: '1 час', minutes: 60 },
    { label: '3 часа', minutes: 180 },
    { label: '6 часов', minutes: 360 },
    { label: '12 часов', minutes: 720 },
    { label: '1 день', minutes: 1440 },
    { label: '2 дня', minutes: 2880 },
    { label: '3 дня', minutes: 4320 },
];

// Разбирает ввод вида "90", "90м", "2ч", "1.5ч", "3д", "2h", "1d" в минуты.
// Число без единицы считается минутами.
function parseDurationToMinutes(text) {
    const cleaned = text.trim().toLowerCase().replace(/\s+/g, '');
    const match = cleaned.match(/^(\d+(?:[.,]\d+)?)(мин|м|min|m|часа|часов|час|ч|h|дней|дня|день|д|d)?$/);
    if (!match) return null;
    const value = parseFloat(match[1].replace(',', '.'));
    const unit = match[2] || 'м';
    let minutes;
    if (['часа', 'часов', 'час', 'ч', 'h'].includes(unit)) minutes = value * 60;
    else if (['дней', 'дня', 'день', 'д', 'd'].includes(unit)) minutes = value * 60 * 24;
    else minutes = value;
    minutes = Math.round(minutes);
    return minutes > 0 ? minutes : null;
}

// Красиво пишет длительность: "90 мин" -> "1 ч 30 мин", "1500" -> "1 д 1 ч"
function formatDurationMinutes(totalMin) {
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    const parts = [];
    if (d) parts.push(`${d} д`);
    if (h) parts.push(`${h} ч`);
    if (m || parts.length === 0) parts.push(`${m} мин`);
    return parts.join(' ');
}

function characterKeyboard(characters) {
    const rows = characters.map((c, i) => [{ text: c.name, callback_data: `ac:${i}` }]);
    rows.push([{ text: '👤 Новый персонаж', callback_data: 'cnt' }]);
    return { inline_keyboard: rows };
}

function durationKeyboard() {
    const rows = [];
    for (let i = 0; i < DURATION_PRESETS.length; i += 3) {
        rows.push(DURATION_PRESETS.slice(i, i + 3).map(p => ({ text: p.label, callback_data: `ad:${p.minutes}` })));
    }
    rows.push([{ text: '✏️ Своё время (минуты / часы / дни)', callback_data: 'ad:custom' }]);
    return { inline_keyboard: rows };
}

function timerDetailKeyboard(timerId, characterId) {
    return {
        inline_keyboard: [
            [{ text: '🔄 Перезапустить', callback_data: `tr:${timerId}` }, { text: '🗑️ Удалить', callback_data: `td:${timerId}` }],
            [{ text: '⬅️ Назад к таймерам', callback_data: `tc:${characterId}` }],
        ],
    };
}

// Состояние пошагового добавления таймера (/timer_add), по одному на чат
const timerAddState = new Map();

async function handleTimerAddStep(msg) {
    const state = timerAddState.get(msg.chat.id);
    const text = msg.text.trim();

    if (state.step === 'quest_name') {
        state.questName = text;
        state.step = 'duration';
        timerAddState.set(msg.chat.id, state);
        bot.sendMessage(msg.chat.id, 'На сколько поставить таймер?', { reply_markup: durationKeyboard() }).catch(logSendErr);
        return;
    }

    if (state.step === 'duration_custom') {
        const minutes = parseDurationToMinutes(text);
        if (!minutes) {
            bot.sendMessage(msg.chat.id,
                'Не понял время. Примеры: 90 (минуты), 45м, 2ч, 1.5ч, 3д — попробуй ещё раз.'
            ).catch(logSendErr);
            return;
        }
        await finishTimerAdd(msg.chat.id, state, minutes);
    }
}

async function finishTimerAdd(chatId, state, minutes) {
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
    timerAddState.delete(chatId);
    if (error) {
        console.error('Ошибка создания таймера:', error.message);
        bot.sendMessage(chatId, '❌ Не удалось создать таймер.').catch(logSendErr);
        return;
    }
    bot.sendMessage(chatId, `✅ Таймер «${state.questName}» на ${formatDurationMinutes(minutes)} добавлен персонажу ${state.characterName}.`).catch(logSendErr);
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
        { command: 'timers', description: 'Мои таймеры (с кнопками управления)' },
        { command: 'timer_add', description: 'Добавить новый таймер' },
        { command: 'char_add', description: 'Создать нового персонажа' },
        { command: 'watch_game', description: 'Следить, не упала ли игра (mmobitva.ru/.net)' },
        { command: 'unwatch_game', description: 'Выключить уведомления о доступности игры' },
        { command: 'nytik', description: 'Нытик дня (в группе)' },
    ]).catch(err => console.error('Не удалось задать список команд:', err.message));
});

// ==================== КОМАНДЫ ====================

// ==================== СЛЕЖЕНИЕ ЗА ДОСТУПНОСТЬЮ ИГРОВЫХ ДОМЕНОВ ====================
// Бот не может знать настоящую причину сбоя (упал хостинг, идут работы,
// DDoS и т.п.) — только технический симптом (не отвечает / ошибка сервера /
// не резолвится DNS). Честно сообщаем именно это, без выдумок.

const GAME_DOMAINS = [
    { name: 'mmobitva.ru', url: 'https://mmobitva.ru/' },
    { name: 'mobitva.net', url: 'https://mobitva.net/' },
];
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FAIL_THRESHOLD = 2; // столько неудачных проверок подряд, прежде чем объявить "не работает"

const domainState = new Map(); // name -> { up: true|false|null, failCount: number }

async function getWatchChats() {
    const { data, error } = await supabaseAdmin.from('watch_chats').select('chat_id');
    if (error) { console.error('getWatchChats:', error.message); return []; }
    return (data || []).map(r => r.chat_id);
}

async function notifyWatchers(text) {
    const chats = await getWatchChats();
    for (const chatId of chats) {
        bot.sendMessage(chatId, text).catch(logSendErr);
    }
}

async function checkDomain(domain) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(domain.url, { signal: controller.signal, redirect: 'follow' });
        clearTimeout(timeout);
        if (res.status >= 500) return { up: false, reason: `сервер вернул ошибку ${res.status}` };
        return { up: true };
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') return { up: false, reason: 'не отвечает (таймаут)' };
        const code = e.cause && e.cause.code;
        if (code === 'ENOTFOUND') return { up: false, reason: 'не резолвится домен (проблема с DNS)' };
        if (code === 'ECONNREFUSED') return { up: false, reason: 'сервер отказывается принимать соединения' };
        return { up: false, reason: 'недоступен (ошибка соединения)' };
    }
}

const QUICK_RECHECK_MS = 30 * 1000; // подтверждающая проверка — быстро, не ждём весь цикл

async function checkSingleDomain(domain) {
    const result = await checkDomain(domain);
    let state = domainState.get(domain.name) || { up: null, failCount: 0 };

    if (result.up) {
        const wasDown = state.up === false;
        domainState.set(domain.name, { up: true, failCount: 0 });
        if (wasDown) await notifyWatchers(`✅ ${domain.name} снова работает!`);
        return;
    }

    state.failCount++;
    if (state.up !== false && state.failCount >= FAIL_THRESHOLD) {
        domainState.set(domain.name, { up: false, failCount: state.failCount });
        await notifyWatchers(`🔴 ${domain.name} не отвечает — ${result.reason}. Похоже, игра временно недоступна.`);
    } else {
        domainState.set(domain.name, state);
        // не нашли проблему окончательно — перепроверим быстро, не через 5 минут
        setTimeout(() => checkSingleDomain(domain).catch(e => console.error('Ошибка проверки домена:', e.message)), QUICK_RECHECK_MS);
    }
}

async function checkGameDomainsAndNotify() {
    for (const domain of GAME_DOMAINS) {
        await checkSingleDomain(domain);
    }
}

setTimeout(() => checkGameDomainsAndNotify().catch(e => console.error('Ошибка проверки доменов:', e.message)), 20000);
setInterval(() => checkGameDomainsAndNotify().catch(e => console.error('Ошибка проверки доменов:', e.message)), CHECK_INTERVAL_MS);

bot.onText(/^\/watch_game/, async (msg) => {
    const { error } = await supabaseAdmin.from('watch_chats').upsert([{ chat_id: msg.chat.id }], { onConflict: 'chat_id' });
    bot.sendMessage(msg.chat.id, error
        ? '❌ Не удалось включить уведомления.'
        : `✅ Буду писать сюда, если ${GAME_DOMAINS.map(d => d.name).join(' или ')} перестанут отвечать (и когда снова заработают).`
    ).catch(logSendErr);
});

bot.onText(/^\/unwatch_game/, async (msg) => {
    const { error } = await supabaseAdmin.from('watch_chats').delete().eq('chat_id', msg.chat.id);
    bot.sendMessage(msg.chat.id, error ? '❌ Не удалось отключить.' : '🔕 Уведомления о доступности игры здесь отключены.').catch(logSendErr);
});

bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        'Привет! Я бот-справочник по игре МоБитва.\n\n' +
        '🔍 Поиск: просто напиши название предмета, руны, тотема и т.д.\n\n' +
        '✈️ Чтобы управлять таймерами прямо из чата (только в личных сообщениях), сначала привяжи аккаунт сайта:\n' +
        'зайди в личный кабинет на mobitva.help → раздел «Telegram-бот» → получи код → /link КОД\n\n' +
        'После привязки:\n' +
        '/timers — персонажи и их таймеры с кнопками (перезапустить/удалить)\n' +
        '/timer_add — добавить таймер (время: минуты, часы или дни)\n' +
        '/char_add — создать нового персонажа\n\n' +
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
    if (!requirePrivateChat(msg)) return;
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
    bot.sendMessage(msg.chat.id, `✅ Готово! Telegram привязан к аккаунту «${data.login}». Команда /timers покажет твои таймеры.`).catch(logSendErr);
});

bot.onText(/^\/unlink/, async (msg) => {
    if (!requirePrivateChat(msg)) return;
    const { error } = await supabaseAdmin.from('telegram_links').delete().eq('telegram_chat_id', msg.chat.id);
    bot.sendMessage(msg.chat.id, error ? 'Не удалось отвязать.' : '🔌 Telegram отвязан от аккаунта на сайте.').catch(logSendErr);
});

bot.onText(/^\/timers/, async (msg) => {
    if (!requirePrivateChat(msg)) return;
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;
    const view = await buildCharactersView(login);
    bot.sendMessage(msg.chat.id, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard || undefined }).catch(logSendErr);
});

async function startTimerAddFlow(chatId, login) {
    const characters = await getCharactersByLogin(login);
    if (characters.length === 0) {
        bot.sendMessage(chatId, 'У тебя пока нет персонажей. Сначала создай первого:', {
            reply_markup: { inline_keyboard: [[{ text: '➕ Создать персонажа', callback_data: 'cnt' }]] },
        }).catch(logSendErr);
        return;
    }
    if (characters.length === 1) {
        timerAddState.set(chatId, { step: 'quest_name', login, characterId: characters[0].id, characterName: characters[0].name });
        bot.sendMessage(chatId, `Персонаж: ${characters[0].name}\nНапиши название квеста/таймера:`, { reply_markup: { force_reply: true } }).catch(logSendErr);
    } else {
        timerAddState.set(chatId, { step: 'character', login, characters });
        bot.sendMessage(chatId, 'Выбери персонажа:', { reply_markup: characterKeyboard(characters) }).catch(logSendErr);
    }
    setTimeout(() => timerAddState.delete(chatId), 5 * 60 * 1000);
}

// ---- Создание персонажа ----
const charAddState = new Map(); // chatId -> { login, thenTimerAdd }

async function createCharacter(chatId, login, name, thenTimerAdd) {
    const cleanName = name.trim().slice(0, 40);
    if (!cleanName) {
        bot.sendMessage(chatId, 'Имя не может быть пустым. Напиши имя персонажа ещё раз:', { reply_markup: { force_reply: true } }).catch(logSendErr);
        return false;
    }
    const characters = await getCharactersByLogin(login);
    if (characters.some(c => c.name.trim().toLowerCase() === cleanName.toLowerCase())) {
        bot.sendMessage(chatId, `Персонаж «${cleanName}» у тебя уже есть. Напиши другое имя:`, { reply_markup: { force_reply: true } }).catch(logSendErr);
        return false;
    }
    const maxOrder = characters.reduce((max, c) => Math.max(max, c.order_index || 0), 0);
    const { error } = await supabaseAdmin
        .from('user_characters')
        .insert([{ user_id: login, name: cleanName, order_index: maxOrder + 1 }]);
    charAddState.delete(chatId);
    if (error) {
        console.error('Ошибка создания персонажа:', error.message);
        bot.sendMessage(chatId, '❌ Не удалось создать персонажа.').catch(logSendErr);
        return true;
    }
    bot.sendMessage(chatId, `✅ Персонаж «${cleanName}» создан!`).catch(logSendErr);
    if (thenTimerAdd) await startTimerAddFlow(chatId, login);
    return true;
}

function askCharacterName(chatId, login, thenTimerAdd) {
    charAddState.set(chatId, { login, thenTimerAdd: !!thenTimerAdd });
    setTimeout(() => charAddState.delete(chatId), 5 * 60 * 1000);
    bot.sendMessage(chatId, 'Напиши имя нового персонажа:', { reply_markup: { force_reply: true } }).catch(logSendErr);
}

bot.onText(/^\/char_add(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!requirePrivateChat(msg)) return;
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;
    const name = match[1] ? match[1].trim() : '';
    if (!name) {
        askCharacterName(msg.chat.id, login, false);
        return;
    }
    await createCharacter(msg.chat.id, login, name, false);
});

bot.onText(/^\/timer_add/, async (msg) => {
    if (!requirePrivateChat(msg)) return;
    const login = await requireLinkedLogin(msg.chat.id);
    if (!login) return;
    await startTimerAddFlow(msg.chat.id, login);
});

// ---- Обработка нажатий на инлайн-кнопки ----
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    bot.answerCallbackQuery(query.id).catch(() => {});

    if (query.message.chat.type !== 'private') {
        bot.sendMessage(chatId, '🔒 Управление таймерами работает только в личных сообщениях боту.').catch(logSendErr);
        return;
    }

    const login = await getLinkedLogin(chatId);
    if (!login) {
        bot.sendMessage(chatId, 'Сначала привяжи аккаунт: /link КОД').catch(logSendErr);
        return;
    }

    // Выбор персонажа при добавлении таймера
    if (data.startsWith('ac:')) {
        const state = timerAddState.get(chatId);
        if (!state || state.step !== 'character') return;
        const idx = parseInt(data.slice(3), 10);
        const chosen = state.characters[idx];
        if (!chosen) return;
        state.characterId = chosen.id;
        state.characterName = chosen.name;
        state.step = 'quest_name';
        timerAddState.set(chatId, state);
        bot.sendMessage(chatId, `Персонаж: ${chosen.name}\nНапиши название квеста/таймера:`, { reply_markup: { force_reply: true } }).catch(logSendErr);
        return;
    }

    // Выбор длительности при добавлении таймера
    if (data.startsWith('ad:')) {
        const state = timerAddState.get(chatId);
        if (!state || state.step !== 'duration') return;
        const value = data.slice(3);
        if (value === 'custom') {
            state.step = 'duration_custom';
            timerAddState.set(chatId, state);
            bot.sendMessage(chatId, 'Напиши время: просто число = минуты, либо с буквой — например 90, 45м, 2ч, 1.5ч, 3д:', { reply_markup: { force_reply: true } }).catch(logSendErr);
            return;
        }
        await finishTimerAdd(chatId, state, parseInt(value, 10));
        return;
    }

    // Создать нового персонажа (просто создать / создать и сразу добавить таймер)
    if (data === 'cn' || data === 'cnt') {
        timerAddState.delete(chatId);
        askCharacterName(chatId, login, data === 'cnt');
        return;
    }

    // Начать добавление таймера кнопкой из списка
    if (data === 'add') {
        await startTimerAddFlow(chatId, login);
        return;
    }

    // Вернуться к списку персонажей
    if (data === 'tb') {
        const view = await buildCharactersView(login);
        bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard || undefined }).catch(logSendErr);
        return;
    }

    // Открыть таймеры конкретного персонажа
    if (data.startsWith('tc:')) {
        const characterId = parseInt(data.slice(3), 10);
        const view = await buildCharacterTimersView(login, characterId);
        bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard || undefined }).catch(logSendErr);
        return;
    }

    // Открыть карточку конкретного таймера
    if (data.startsWith('tl:')) {
        const timerId = parseInt(data.slice(3), 10);
        const timer = await getTimerWithAuth(timerId, login);
        if (!timer) { bot.sendMessage(chatId, 'Таймер не найден.').catch(logSendErr); return; }
        const status = timer.is_active ? formatRemaining(timer.end_time) : 'на паузе';
        bot.sendMessage(chatId, `${statusEmoji(timer)} <b>${escapeHtml(timer.quest_name)}</b>\nОсталось: ${status}`, {
            parse_mode: 'HTML',
            reply_markup: timerDetailKeyboard(timerId, timer.character_id),
        }).catch(logSendErr);
        return;
    }

    // Удалить таймер
    if (data.startsWith('td:')) {
        const timerId = parseInt(data.slice(3), 10);
        const timer = await getTimerWithAuth(timerId, login);
        if (!timer) { bot.sendMessage(chatId, 'Таймер не найден.').catch(logSendErr); return; }
        const characterId = timer.character_id;
        const { error } = await supabaseAdmin.from('user_timers').delete().eq('id', timerId);
        if (error) { bot.sendMessage(chatId, '❌ Не удалось удалить.').catch(logSendErr); return; }
        const view = await buildCharacterTimersView(login, characterId);
        bot.sendMessage(chatId, `🗑️ Таймер «${escapeHtml(timer.quest_name)}» удалён.\n\n${view.text}`, {
            parse_mode: 'HTML',
            reply_markup: view.keyboard || undefined,
        }).catch(logSendErr);
        return;
    }

    // Перезапустить таймер
    if (data.startsWith('tr:')) {
        const timerId = parseInt(data.slice(3), 10);
        const timer = await getTimerWithAuth(timerId, login);
        if (!timer) { bot.sendMessage(chatId, 'Таймер не найден.').catch(logSendErr); return; }
        const newEndTime = Date.now() + timer.duration;
        const { error } = await supabaseAdmin
            .from('user_timers')
            .update({ end_time: newEndTime, is_active: true, notified_at: null })
            .eq('id', timerId);
        if (error) { bot.sendMessage(chatId, '❌ Не удалось перезапустить.').catch(logSendErr); return; }
        bot.sendMessage(chatId, `🔄 Таймер «${escapeHtml(timer.quest_name)}» перезапущен.`, {
            parse_mode: 'HTML',
            reply_markup: timerDetailKeyboard(timerId, timer.character_id),
        }).catch(logSendErr);
    }
});

// Любое обычное сообщение без команды — либо шаг мастера /timer_add,
// либо поиск (только в личных чатах с ботом).
// ==================== "НЫТИК ДНЯ" ====================
// Telegram не даёт боту список всех участников группы — зато бот видит
// каждое сообщение, поэтому сам запоминает, кто писал в чат, и раз в сутки
// выбирает случайного из уже замеченных.

const groupMembers = new Map(); // chatId -> Map(userId -> имя)

// Эти люди никогда не становятся "нытиком дня" — просто исключаем их
// из списка кандидатов на этапе отслеживания сообщений.
const WHINER_EXCLUDED_USERNAMES = ['laa_dan', 'e_v_g_e_x_a'];

function trackGroupMember(msg) {
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
    if (!msg.from || msg.from.is_bot) return;
    const username = (msg.from.username || '').toLowerCase();
    if (WHINER_EXCLUDED_USERNAMES.includes(username)) return;
    if (!groupMembers.has(msg.chat.id)) groupMembers.set(msg.chat.id, new Map());
    const name = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
    groupMembers.get(msg.chat.id).set(msg.from.id, name);
}

bot.on('message', (msg) => trackGroupMember(msg));

function todayKey() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD по UTC
}

// Читает из базы, кто уже объявлен нытиком дня в этом чате (если есть на сегодня)
async function getTodaysWhiner(chatId) {
    const { data, error } = await supabaseAdmin
        .from('daily_whiner')
        .select('*')
        .eq('chat_id', chatId)
        .maybeSingle();
    if (error) { console.error('getTodaysWhiner:', error.message); return null; }
    if (!data || data.date !== todayKey()) return null;
    return data;
}

// Выбирает нового нытика дня и сохраняет в базу (переживает перезапуски бота)
async function pickAndSaveWhiner(chatId) {
    const members = groupMembers.get(chatId);
    if (!members || members.size === 0) return null;
    const ids = Array.from(members.keys());
    const pickId = ids[Math.floor(Math.random() * ids.length)];
    const name = members.get(pickId);
    const record = { chat_id: chatId, date: todayKey(), user_id: pickId, user_name: name };
    const { error } = await supabaseAdmin.from('daily_whiner').upsert([record], { onConflict: 'chat_id' });
    if (error) { console.error('pickAndSaveWhiner:', error.message); return null; }
    return record;
}

function whinerMention(record) {
    return `<a href="tg://user?id=${record.user_id}">${escapeHtml(record.user_name)}</a>`;
}

// Фоновая проверка — раз в час смотрим по каждому известному чату,
// объявлен ли уже сегодняшний нытик; если нет, выбираем и объявляем.
async function checkDailyWhiner() {
    for (const chatId of groupMembers.keys()) {
        const existing = await getTodaysWhiner(chatId);
        if (existing) continue;
        const record = await pickAndSaveWhiner(chatId);
        if (!record) continue;
        bot.sendMessage(chatId, `😤 Нытик дня: ${whinerMention(record)}! Поздравляем, держи корону 👑`, { parse_mode: 'HTML' }).catch(logSendErr);
    }
}

setInterval(() => checkDailyWhiner().catch(e => console.error('Ошибка "нытика дня":', e.message)), 60 * 60 * 1000);

// Команда для ручного запроса в группе: если нытик дня ещё не объявлен — объявляет
// прямо сейчас; если уже объявлен — просто напоминает, кто сегодня победил.
bot.onText(/^\/nytik/, async (msg) => {
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
        bot.sendMessage(msg.chat.id, 'Эта команда работает только в групповом чате.').catch(logSendErr);
        return;
    }
    const existing = await getTodaysWhiner(msg.chat.id);
    if (existing) {
        bot.sendMessage(msg.chat.id, `Нытик дня уже объявлен: ${whinerMention(existing)} 👑 (следующий — завтра)`, { parse_mode: 'HTML' }).catch(logSendErr);
        return;
    }
    const record = await pickAndSaveWhiner(msg.chat.id);
    if (!record) {
        bot.sendMessage(msg.chat.id, 'Пока не видел здесь никого, кроме исключённых — не из кого выбирать 🤷').catch(logSendErr);
        return;
    }
    bot.sendMessage(msg.chat.id, `😤 Нытик дня: ${whinerMention(record)}! Поздравляем, держи корону 👑`, { parse_mode: 'HTML' }).catch(logSendErr);
});

// ==================== ПАСХАЛКИ И ПОДКОЛЫ ====================

const EASTER_EGGS = [
    {
        pattern: /^как\s*дела\??$/i,
        responses: [
            'Дела как у твоих таймеров — то и дело что-то горит, но я держусь.',
            'Нормально, бока намяло от твоих запросов, но живой.',
            'Дела — отвечаю на вопросы и смотрю, как вы опять забыли про таймер. Как обычно, короче.',
        ],
    },
    {
        pattern: /^(ты\s*жив[а-я]*|ты\s*тут|ты\s*онлайн|живой\??)\??$/i,
        responses: [
            'Жив, не ссы. В отличие от твоего последнего таймера, который сдох ещё час назад.',
            'Тут я, тут. Кто бы ещё за тебя квесты помнил.',
            'Живее всех живых, чего не скажешь про твою удачу в поиске секреток.',
        ],
    },
    {
        pattern: /расскажи\s*анекдот/i,
        responses: [
            'Прихожу к игроку домой, а у него все таймеры истекли ещё вчера. Вот это я понимаю, анекдот.',
            'Купил мужик меч +32 урона, принёс домой — а там уже другой выбит. Как и твои планы на сегодня.',
            'Не рассказываю анекдоты, я и так один сплошной анекдот — бот на бесплатном хостинге, который иногда засыпает.',
        ],
    },
    {
        pattern: /(спасибо|благодарю|спс|пасиб)/i,
        responses: [
            'Не за что, бро. Иди лучше таймер поставь, а не спасибовай.',
            'Всегда пожалуйста. Любовь к боту можно выразить и так: не спамь мне в 4 утра.',
            'Пожалуйста. Теперь иди и перестань терять свои секретки.',
        ],
    },
    {
        pattern: /^(ты\s*кто|кто\s*ты)\??$/i,
        responses: [
            'Я тот самый бот, который помнит про твои таймеры лучше, чем ты сам.',
            'Скромный слуга клана МоБитва. Ищу предметы, слежу за таймерами и иногда подкалываю. Как сейчас.',
        ],
    },
];

function matchEasterEgg(text) {
    const trimmed = text.trim();
    for (const egg of EASTER_EGGS) {
        if (egg.pattern.test(trimmed)) {
            return egg.responses[Math.floor(Math.random() * egg.responses.length)];
        }
    }
    return null;
}

const NIGHT_OWL_JABS = [
    '🦉 Полночь на дворе, а ты всё ещё тут сидишь. Ладно, держи что просил:',
    '🌙 {hour}:00, а тебе всё неймётся. Окей, отвечаю, но ложиться спать я тебе не запрещаю:',
    '😴 Нормальные люди в это время спят, а ты боту пишешь. Уважаю фанатизм. Вот ответ:',
    '🌃 Самое время для таймеров и бессонницы, да? Ладно, разбираемся:',
];

// Московское время (UTC+3) — поменяй смещение в TZ_OFFSET_HOURS, если клан в другом поясе
const TZ_OFFSET_HOURS = 3;

function maybeNightOwlJab(msgDateUnix) {
    const utcHour = new Date(msgDateUnix * 1000).getUTCHours();
    const localHour = (utcHour + TZ_OFFSET_HOURS) % 24;
    if (localHour >= 0 && localHour < 5 && Math.random() < 0.5) {
        const template = NIGHT_OWL_JABS[Math.floor(Math.random() * NIGHT_OWL_JABS.length)];
        return template.replace('{hour}', localHour);
    }
    return null;
}

bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    if (msg.chat.type !== 'private') return;

    if (charAddState.has(msg.chat.id)) {
        const state = charAddState.get(msg.chat.id);
        await createCharacter(msg.chat.id, state.login, msg.text.trim(), state.thenTimerAdd);
        return;
    }

    if (timerAddState.has(msg.chat.id)) {
        await handleTimerAddStep(msg);
        return;
    }

    const eggReply = matchEasterEgg(msg.text);
    if (eggReply) {
        bot.sendMessage(msg.chat.id, eggReply).catch(logSendErr);
        return;
    }

    const jab = maybeNightOwlJab(msg.date);
    if (jab) await bot.sendMessage(msg.chat.id, jab).catch(logSendErr);

    await handleSearch(msg.chat.id, msg.text.trim());
});
