// ====================================================================
// Telegram-бот для Mobitva.help
//
// Что делает: человек пишет боту название чего угодно из базы (предмет,
// руна, тотем, круг демона, наколка, усиление, секретная вещь/сет) —
// бот ищет совпадения СРАЗУ по всем категориям, прощает опечатки и
// недописанные слова (нечёткий поиск), и присылает в чат название,
// уровень, характеристики и прямую ссылку.
//
// Работает в режиме webhook: Telegram сам присылает сообщения на наш
// сервер по HTTP — это нужно, чтобы бесплатный хостинг (Render) считал
// сервис обычным веб-сервисом и не требовал постоянного опроса.
// ====================================================================

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const Fuse = require('fuse.js');

// ---- Настройки (задаются как переменные окружения на хостинге) ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // например https://mobitva-bot.onrender.com
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = 'https://gmcqxgxwtczjlwyifwew.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtY3F4Z3h3dGN6amx3eWlmd2V3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0MjIxMTAsImV4cCI6MjA5MDk5ODExMH0.cM6xm9qCRbl-c1h-pWOWKSeAozYUy7KpJjua79JgFuk';
const SITE_URL = 'https://mobitva.help';

if (!BOT_TOKEN) {
    console.error('! Не задана переменная окружения BOT_TOKEN. Бот не может запуститься.');
    process.exit(1);
}
if (!PUBLIC_URL) {
    console.error('! Не задана переменная окружения PUBLIC_URL (адрес самого бота на хостинге).');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: { transport: WebSocket },
    auth: { persistSession: false },
});

// Те же категории, что и на сайте (см. scripts/generate-share-pages.js в репозитории сайта)
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

// ---- Кэш данных для поиска: перечитываем базу раз в 10 минут,
//      а не при каждом сообщении, чтобы не дёргать Supabase зря ----
let searchIndex = null; // Fuse-индекс (нечёткий поиск)
let allEntries = [];    // плоский список всех записей (для точного совпадения)

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

async function rebuildIndex() {
    const combined = [];
    for (const cat of CATEGORIES) {
        try {
            const { data, error } = await supabase.from(cat.table).select('*');
            if (error) {
                console.warn(`! Не удалось получить "${cat.table}":`, error.message);
                continue;
            }
            for (const row of data || []) {
                combined.push({ ...row, __cat: cat });
            }
        } catch (e) {
            console.warn(`! Ошибка при получении "${cat.table}":`, e.message);
        }
    }
    allEntries = combined;
    searchIndex = new Fuse(combined, {
        keys: ['name'],
        threshold: 0.4,       // чем больше — тем терпимее к опечаткам (0 = точное совпадение, 1 = почти всё подряд)
        ignoreLocation: true, // не важно, в каком месте строки совпадение
        minMatchCharLength: 2,
    });
    console.log(`Индекс поиска обновлён: ${combined.length} записей.`);
}

// Первая загрузка при старте + периодическое обновление
rebuildIndex().catch(e => console.error('Не удалось построить индекс при старте:', e.message));
setInterval(() => rebuildIndex().catch(e => console.error('Не удалось обновить индекс:', e.message)), REFRESH_INTERVAL_MS);

// ---- Express-сервер ----
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
    ]).catch(err => console.error('Не удалось задать список команд:', err.message));
});

// ---- Форматирование ответа ----

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

// ---- Поиск (нечёткий, по всем категориям сразу) ----
function search(query) {
    if (!searchIndex) return [];
    return searchIndex.search(query, { limit: 5 }).map(r => r.item);
}

// ---- Команды ----
bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        'Привет! Я бот-справочник по игре МоБитва.\n\n' +
        'Просто напиши название чего угодно из игры — предмета, руны, тотема, ' +
        'круга демона, наколки, усиления, секретной вещи или сета. ' +
        'Ищу сразу по всей базе, опечатки не страшны.\n\n' +
        `Полная база: ${SITE_URL}`
    ).catch(e => console.error('Ошибка отправки:', e.message));
});

bot.onText(/^\/item(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const query = match[1] ? match[1].trim() : '';
    if (!query) {
        if (msg.chat.type === 'private') {
            bot.sendMessage(msg.chat.id, 'Что ищем? Напиши название предмета, руны, тотема и т.д. следующим сообщением:', {
                reply_markup: { force_reply: true }
            }).catch(e => console.error('Ошибка отправки:', e.message));
        } else {
            // В группе не задаём отдельный вопрос — его увидели бы все участники.
            // Вместо этого короткая подсказка, как написать всё одной командой.
            bot.sendMessage(msg.chat.id, 'В группе пиши сразу вместе с названием, например: /item меч огня')
                .catch(e => console.error('Ошибка отправки:', e.message));
        }
        return;
    }
    await handleSearch(msg.chat.id, query);
});

// Любое обычное сообщение без команды тоже воспринимаем как поиск —
// но только в личных чатах с ботом. В группах ищем только по полной
// команде /item название, чтобы бот не встревал в чужие разговоры.
bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return; // команды обработаны выше
    if (msg.chat.type !== 'private') return;
    await handleSearch(msg.chat.id, msg.text.trim());
});

async function handleSearch(chatId, query) {
    if (!query) return;
    try {
        if (!searchIndex) {
            bot.sendMessage(chatId, 'Секунду, ещё загружаю базу данных — попробуй написать ещё раз через пару секунд.').catch(e => console.error('Ошибка отправки:', e.message));
            return;
        }

        // Сначала проверяем точное совпадение по названию (без учёта регистра/пробелов).
        const normalizedQuery = query.trim().toLowerCase();
        const exactMatches = allEntries.filter(e => e.name && e.name.trim().toLowerCase() === normalizedQuery);

        if (exactMatches.length > 0) {
            const text = exactMatches.map(formatEntry).join('\n\n———\n\n');
            bot.sendMessage(chatId, text, { disable_web_page_preview: true }).catch(e => console.error('Ошибка отправки:', e.message));
            return;
        }

        // Точного совпадения нет — ищем похожее (нечёткий поиск).
        const results = search(query);
        if (results.length === 0) {
            bot.sendMessage(chatId, `Такого нет: «${query}». Похожего тоже ничего не нашёл — попробуй сформулировать иначе.`).catch(e => console.error('Ошибка отправки:', e.message));
            return;
        }
        const text = `Точного совпадения с «${query}» нет, но вот похожее:\n\n` +
            results.map(formatEntry).join('\n\n———\n\n');
        bot.sendMessage(chatId, text, { disable_web_page_preview: true }).catch(e => console.error('Ошибка отправки:', e.message));
    } catch (e) {
        console.error('Ошибка обработки запроса:', e);
        bot.sendMessage(chatId, 'Что-то пошло не так при поиске. Попробуй ещё раз чуть позже.').catch(e => console.error('Ошибка отправки:', e.message));
    }
}
