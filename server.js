// ====================================================================
// Telegram-бот для Mobitva.help
//
// Что делает: человек пишет боту название предмета (например "меч огня"
// или командой /item меч огня) — бот ищет совпадения в той же базе
// данных Supabase, которой пользуется сайт, и присылает в чат название,
// уровень, характеристики и прямую ссылку на предмет на сайте.
//
// Работает в режиме webhook: Telegram сам присылает сообщения на наш
// сервер по HTTP, а не бот постоянно "спрашивает" Telegram — это нужно,
// чтобы бесплатный хостинг (Render) считал сервис обычным веб-сервисом.
// ====================================================================

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

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

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });
const app = express();
app.use(express.json());

// ---- Приём сообщений от Telegram ----
app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ---- Проверка живости (для автопинга через GitHub Actions) ----
app.get('/', (req, res) => res.send('Mobitva bot is alive'));
app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, () => {
    console.log(`Сервер бота запущен на порту ${PORT}`);
    bot.setWebHook(`${PUBLIC_URL}/webhook`)
        .then(() => console.log('Webhook установлен:', `${PUBLIC_URL}/webhook`))
        .catch(err => console.error('Не удалось установить webhook:', err.message));
});

// ---- Поиск предметов ----
async function searchItems(query) {
    const { data, error } = await supabase
        .from('items')
        .select('*')
        .ilike('name', `%${query}%`)
        .limit(5);
    if (error) {
        console.error('Ошибка поиска в Supabase:', error.message);
        return [];
    }
    return data || [];
}

function formatItem(item) {
    const lines = [];
    lines.push(`⚔️ *${escapeMarkdown(item.name)}*`);
    if (item.level !== undefined && item.level !== null) lines.push(`Уровень: ${item.level}`);
    if (item.stats && typeof item.stats === 'object') {
        const statsText = Object.entries(item.stats)
            .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
        if (statsText) lines.push(statsText);
    }
    if (item.description) lines.push(`_${escapeMarkdown(String(item.description))}_`);
    lines.push(`🔗 ${SITE_URL}/share/items/${item.id}/`);
    return lines.join('\n');
}

function escapeMarkdown(text) {
    return String(text).replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}

// ---- Команды ----
bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        'Привет! Я бот-справочник по игре МоБитва.\n\n' +
        'Напиши мне название предмета (например "меч огня") или используй команду:\n' +
        '/item <название> — поиск предмета\n\n' +
        `Полная база: ${SITE_URL}`
    );
});

bot.onText(/^\/item(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const query = match[1].trim();
    await handleSearch(msg.chat.id, query);
});

// Любое обычное сообщение без команды тоже воспринимаем как поиск
bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return; // команды обработаны выше
    await handleSearch(msg.chat.id, msg.text.trim());
});

async function handleSearch(chatId, query) {
    if (!query) return;
    try {
        const items = await searchItems(query);
        if (items.length === 0) {
            bot.sendMessage(chatId, `Ничего не нашёл по запросу «${query}». Попробуй сформулировать иначе.`);
            return;
        }
        const text = items.map(formatItem).join('\n\n———\n\n');
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) {
        console.error('Ошибка обработки запроса:', e);
        bot.sendMessage(chatId, 'Что-то пошло не так при поиске. Попробуй ещё раз чуть позже.');
    }
}
