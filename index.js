const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

// --- Загружаем переменные из .env ---
require('dotenv').config();

// --- Создаём бота ---
const bot = new Telegraf(process.env.BOT_TOKEN);

if (!process.env.BOT_TOKEN) {
  console.error('❌ Не найден BOT_TOKEN в .env');
  process.exit(1);
}

// --- Подключаемся к Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('❌ Не найдены ключи Supabase в .env');
  process.exit(1);
}

const pfpsDir = path.resolve(__dirname, 'pfps');
const artsDir = path.resolve(__dirname, 'arts');

// Регистрируем викторину по артам
const registerQuiz = require('./quiz');
let captions = {};

// Загружаем подписи
try {
  const data = fs.readFileSync(path.resolve(__dirname, 'captions.json'), 'utf8');
  captions = JSON.parse(data);
} catch (err) {
  console.error('Не удалось загрузить captions.json:', err.message);
  captions = {};
}

bot.start((ctx) => {
  ctx.reply(
    '🎮 Привет! Выбери игру «Угадай писелярщика по аватарке»! или «Угадай писелярщика по его артам"\nНажми одну из кнопок ниже, чтобы начать:',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Аватарки', callback_data: 'start_game' },
            { text: 'Арты', callback_data: 'start_arts' }
          ]
        ]
      }
    }
  );
});

// Инициализируем модуль викторины по артам
try {
  registerQuiz({ bot, supabase, captions, artsDir });
} catch (err) {
  console.error('Ошибка при регистрации модуля quiz:', err);
}


bot.help((ctx) => ctx.reply('Send me a sticker'));
bot.on('sticker', (ctx) => ctx.reply('👍'));
bot.hears('hi', (ctx) => ctx.reply('Hey there'));

// Хранилище для активных игр (по ID пользователя)
const games = new Map();

// === Обновление статистики канала в Supabase ===
async function updateChannelStats(correctFile, isCorrect) {
  try {
    // Имя файла С расширением, как в captions.json
    const fileNameWithExt = correctFile; // например: "art_2NGAR.jpg"
    const channelId = path.basename(correctFile, path.extname(correctFile)); // → "art_2NGAR"
    const channelName = captions[fileNameWithExt]; // → captions["art_2NGAR.jpg"] → "2NGAR"

    if (!channelName) {
      console.warn(`⚠️ Не найдено название для файла: ${fileNameWithExt}`);
      return; // пропускаем, если нет в captions.json
    }

    // Получаем текущую запись
    const { data, error } = await supabase
      .from('stat')
      .select('*')
      .eq('channel_id', channelId)
      .single();

    if (error && error.code !== 'PGRST116') { // "NotFound"
      console.error('Ошибка при получении статистики:', error.message);
      return;
    }

    if (data) {
      // Обновляем существующую запись
      const newCorrect = data.correct + (isCorrect ? 1 : 0);
      const newWrong = data.wrong + (isCorrect ? 0 : 1);
      const newAll = data.all + 1;
      const newPercent = newAll > 0 ? Math.round((newCorrect / newAll) * 100) : 0;

      await supabase
        .from('stat')
        .update({
          correct: newCorrect,
          wrong: newWrong,
          all: newAll,
          percent: newPercent
        })
        .eq('channel_id', channelId);
    } else {
      // Создаём новую запись
      await supabase
        .from('stat')
        .insert([{
          channel_id: channelId,
          channel_name: channelName,
          correct: isCorrect ? 1 : 0,
          wrong: isCorrect ? 0 : 1,
          all: 1,
          percent: isCorrect ? 100 : 0
        }]);
    }
  } catch (err) {
    console.error('Ошибка при обновлении статистики канала:', err);
  }
}

bot.command('game', async (ctx) => {
  const userId = ctx.from.id;

  try {
    if (!fs.existsSync(pfpsDir)) {
      return ctx.reply('❌ Папка pfps не найдена!');
    }

    const files = fs.readdirSync(pfpsDir);
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    });

    if (imageFiles.length === 0) {
      return ctx.reply('❌ В папке pfps нет картинок!');
    }

    // Сохраняем файлы для игры
    games.set(userId, { imageFiles, pending: 'rounds' });

    // Определяем количество каналов из captions.json
    const totalChannels = Object.keys(captions).length;

    // Варианты раундов
    const roundOptions = [5, 20, 50, 100, 150, 200, 300];
    const filteredOptions = roundOptions.filter(n => n <= totalChannels);
    filteredOptions.push(totalChannels); // Добавляем "все"

    // Генерируем кнопки (по 2 в строку)
    const inlineKeyboard = [];
    for (let i = 0; i < filteredOptions.length; i += 2) {
      const row = [];
      const first = filteredOptions[i];
      const second = filteredOptions[i + 1];

      row.push({
        text: first === totalChannels ? `Все ${first}` : `${first} раундов`,
        callback_data: `rounds_${first}`
      });

      if (second) {
        row.push({
          text: second === totalChannels ? `Все ${second}` : `${second} раундов`,
          callback_data: `rounds_${second}`
        });
      } else {
        row.push({ text: ' ', callback_data: 'noop' }); // пустая кнопка, если нечётное
      }

      inlineKeyboard.push(row);
    }

    await ctx.reply(
      '🎮 Выбери, сколько раундов хочешь сыграть:',
      {
        reply_markup: { inline_keyboard: inlineKeyboard }
      }
    );


  } catch (err) {
    console.error(err);
    ctx.reply('❌ Ошибка при запуске игры.');
  }
});

bot.command('total', async (ctx) => {
  try {
    const { data, error } = await supabase
      .from('stat')
      .select('all');

    if (error) {
      console.error('Ошибка при получении статистики:', error);
      return ctx.reply('❌ Не удалось получить данные.');
    }

    const totalRounds = data.reduce((sum, row) => sum + row.all, 0);

    await ctx.reply(`Общее количество раундов: ${totalRounds}`);
  } catch (err) {
    console.error('Ошибка в /total:', err);
    ctx.reply('❌ Произошла ошибка.');
  }

  updateBotDescription();
});

// Функция для обновления описания бота
// Функция для обновления короткого описания бота
async function updateBotDescription() {
  try {
    // 1. Получаем общее количество раундов
    const { data: stats, error: statsError } = await supabase
      .from('stat')
      .select('all');

    if (statsError) {
      console.error('Ошибка при получении данных для описания:', statsError);
      return;
    }

    const totalRounds = stats.reduce((sum, row) => sum + row.all, 0);

    // 2. Загружаем количество каналов из captions.json
    let channelCount = 0;
    try {
      const captionsRaw = fs.readFileSync(path.resolve(__dirname, 'captions.json'), 'utf8');
      const captionsData = JSON.parse(captionsRaw);
      channelCount = Object.keys(captionsData).length;
    } catch (err) {
      console.error('Ошибка при загрузке captions.json:', err);
      return;
    }

    // 3. Вычисляем среднее
    const avgRoundsPerChannel = channelCount > 0 ? (totalRounds / channelCount).toFixed(1) : '0.0';

    // 4. Формируем описание
    const description = `Общее количество раундов: ${totalRounds}
Среднее на канал: ${avgRoundsPerChannel}`;

    // 5. Обновляем короткое описание бота
    await bot.telegram.setMyShortDescription(description);

    console.log(`✅ Описание бота обновлено: "${description}"`);
  } catch (err) {
    console.error('Ошибка при обновлении описания бота:', err);
  }
}


bot.action('start_game', async (ctx) => {
  await ctx.answerCbQuery(); // убираем "часики"

  const userId = ctx.from.id;

  try {
    if (!fs.existsSync(pfpsDir)) {
      return ctx.reply('❌ Папка pfps не найдена!');
    }

    const files = fs.readdirSync(pfpsDir);
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    });

    if (imageFiles.length === 0) {
      return ctx.reply('❌ В папке pfps нет картинок!');
    }

    games.set(userId, { imageFiles, pending: 'rounds' });

    // Определяем количество каналов из captions.json
    const totalChannels = Object.keys(captions).length;

    // Варианты раундов
    const roundOptions = [5, 20, 50, 100, 150, 200, 300];
    const filteredOptions = roundOptions.filter(n => n <= totalChannels);
    filteredOptions.push(totalChannels); // Добавляем "все"

    // Генерируем кнопки (по 2 в строку)
    const inlineKeyboard = [];
    for (let i = 0; i < filteredOptions.length; i += 2) {
      const row = [];
      const first = filteredOptions[i];
      const second = filteredOptions[i + 1];

      row.push({
        text: first === totalChannels ? `Все ${first}` : `${first} раундов`,
        callback_data: `rounds_${first}`
      });

      if (second) {
        row.push({
          text: second === totalChannels ? `Все ${second}` : `${second} раундов`,
          callback_data: `rounds_${second}`
        });
      } else {
        row.push({ text: ' ', callback_data: 'noop' }); // пустая кнопка, если нечётное
      }

      inlineKeyboard.push(row);
    }

    await ctx.reply(
      '🎮 Выбери, сколько раундов хочешь сыграть:',
      {
        reply_markup: { inline_keyboard: inlineKeyboard }
      }
    );


  } catch (err) {
    console.error(err);
    ctx.reply('❌ Ошибка при запуске игры.');
  }
});


async function sendNextQuestion(ctx, userId) {
  const game = games.get(userId);
  if (!game) return;

  const availableForGuess = game.imageFiles.filter(file => !game.guessed.has(file));
  let correctFile;
  if (availableForGuess.length > 0) {
    correctFile = availableForGuess[Math.floor(Math.random() * availableForGuess.length)];
    game.guessed.add(correctFile);
  } else {
    correctFile = game.imageFiles[Math.floor(Math.random() * game.imageFiles.length)];
  }

  // ✅ Сохраняем текущий файл в game
  game.currentFile = correctFile;

  sendCollage(ctx, game, correctFile);
}

async function sendCollage(ctx, game, correctFile) {
  const correctName = captions[correctFile] || path.basename(correctFile, path.extname(correctFile));

  // Остальные 3 картинки — случайные из всех (могут повторяться)
  const otherFiles = game.imageFiles.filter(f => f !== correctFile);
  const shuffledOthers = otherFiles.sort(() => 0.5 - Math.random());
  const selectedOthers = shuffledOthers.slice(0, 3);

  // Собираем 4 картинки: 1 правильная + 3 случайные
  const allFiles = [correctFile, ...selectedOthers].sort(() => 0.5 - Math.random());
  const correctIndex = allFiles.indexOf(correctFile); // 0, 1, 2 или 3

  const imageSize = 512;
  const canvasWidth = imageSize * 2;
  const canvasHeight = imageSize * 2; // Убрали labelHeight — теперь 2×2 без промежутков

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctxCanvas = canvas.getContext('2d');
  ctxCanvas.fillStyle = '#111';
  ctxCanvas.fillRect(0, 0, canvasWidth, canvasHeight);

  ctxCanvas.font = 'bold 40px Arial';
  ctxCanvas.fillStyle = 'white';
  ctxCanvas.textAlign = 'center';
  ctxCanvas.textBaseline = 'middle';

  // Позиции — теперь строго 2×2
  const positions = [
    { x: 0, y: 0 },
    { x: imageSize, y: 0 },
    { x: 0, y: imageSize },
    { x: imageSize, y: imageSize }
  ];

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    const filePath = path.join(pfpsDir, file);
    const pos = positions[i];

    try {
      const img = await loadImage(filePath);
      const scale = Math.min(imageSize / img.width, imageSize / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const dx = pos.x + (imageSize - w) / 2;
      const dy = pos.y + (imageSize - h) / 2;

      ctxCanvas.drawImage(img, dx, dy, w, h);

      // Рисуем кружок с номером в верхнем левом углу
      ctxCanvas.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctxCanvas.fillRect(pos.x + 10, pos.y + 10, 60, 60);
      ctxCanvas.fillStyle = 'black';
      ctxCanvas.fillText((i + 1).toString(), pos.x + 40, pos.y + 40);
    } catch {
      ctxCanvas.fillStyle = '#666';
      ctxCanvas.fillRect(pos.x, pos.y, imageSize, imageSize);
      ctxCanvas.fillStyle = 'red';
      ctxCanvas.fillText('Ошибка', pos.x + 80, pos.y + 80);
    }
  }

  const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });

  await ctx.replyWithPhoto(
    { source: buffer },
    {
      caption: `Раунд ${game.currentRound + 1}/${game.totalRounds}\nвыбери аватарку: *${correctName}*`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '1', callback_data: `q_${correctIndex + 1}_1` },
            { text: '2', callback_data: `q_${correctIndex + 1}_2` },
            { text: '3', callback_data: `q_${correctIndex + 1}_3` },
            { text: '4', callback_data: `q_${correctIndex + 1}_4` }
          ]
        ]
      }
    }
  );
}

// === Выбор количества раундов ===
bot.action(/^rounds_\d+$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const match = ctx.callbackQuery.data.match(/rounds_(\d+)/);
    const rounds = parseInt(match[1]);

    const userId = ctx.from.id;
    const game = games.get(userId);
    if (!game || game.pending !== 'rounds') return;

    // Убираем pending и устанавливаем настройки игры
    game.pending = null;
    game.totalRounds = rounds;
    game.score = 0;
    game.currentRound = 0;
    game.guessed = new Set(); // сбрасываем угаданные

    await ctx.editMessageText(`🎮 Игра начнётся! Раундов: ${rounds}`);
    await sendNextQuestion(ctx, userId);

  } catch (err) {
    console.error('Ошибка выбора раундов:', err);
    ctx.reply('Произошла ошибка.');
  }
});

// Чтобы игнорировать пустую кнопку
bot.action('noop', (ctx) => ctx.answerCbQuery());


// === Обработчик ответов ===
// === Обработчик ответов ===
bot.action(/^q_\d+_\d+$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const match = ctx.callbackQuery.data.match(/q_(\d+)_(\d+)/);
    const correct = parseInt(match[1]);
    const user = parseInt(match[2]);

    const userId = ctx.from.id;
    const game = games.get(userId);
    if (!game) return;

    // Убираем кнопки
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

    // ✅ Получаем ID канала
    const correctFile = game.currentFile;
    const channelId = path.basename(correctFile, path.extname(correctFile)); // без .jpg

    if (user === correct) {
      game.score++;
      await ctx.reply('🎉 Правильно!');
    } else {
      await ctx.reply(`❌ Неверно! Правильный ответ: ${correct}`);
    }

    // ✅ Обновляем статистику канала
    await updateChannelStats(correctFile, user === correct);

    game.currentRound++;


    // Проверяем — если это последний раунд, отправляем результат СРАЗУ
    if (game.currentRound >= game.totalRounds) {
    await ctx.reply(
      `🏁 Игра окончена! Твой результат: ${game.score} из ${game.totalRounds}`,
      {
      reply_markup: {
        inline_keyboard: [
        [
          { text: '🔁 Играть снова', callback_data: 'play_again' },
          { text: 'Выбрать другую игру', callback_data: 'choose_game' }
        ]
        ]
      }
      }
    );
    games.delete(userId);
    return;
    }



    // Иначе — ждём и отправляем следующий вопрос
    setTimeout(async () => {
      const newCtx = ctx; // можно использовать, потому что мы в пределах одной сессии
      await sendNextQuestion(newCtx, userId);
    }, 1500);

  } catch (err) {
    console.error('Ошибка в обработке ответа:', err);
    ctx.reply('Произошла ошибка.');
  }
});

bot.action('play_again', async (ctx) => {
  await ctx.answerCbQuery(); // чтобы убрать "часики"

  const userId = ctx.from.id;

  try {
    if (!fs.existsSync(pfpsDir)) {
      return ctx.reply('❌ Папка pfps не найдена!');
    }

    const files = fs.readdirSync(pfpsDir);
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    });

    if (imageFiles.length === 0) {
      return ctx.reply('❌ В папке pfps нет картинок!');
    }

    games.set(userId, { imageFiles, pending: 'rounds' });

    // Определяем количество каналов из captions.json
    const totalChannels = Object.keys(captions).length;

    // Варианты раундов
    const roundOptions = [5, 20, 50, 100, 150, 200, 300];
    const filteredOptions = roundOptions.filter(n => n <= totalChannels);
    filteredOptions.push(totalChannels);

    // Генерируем кнопки (по 2 в строку)
    const inlineKeyboard = [];
    for (let i = 0; i < filteredOptions.length; i += 2) {
      const row = [];
      const first = filteredOptions[i];
      const second = filteredOptions[i + 1];

      row.push({
        text: first === totalChannels ? `Все ${first}` : `${first} раундов`,
        callback_data: `rounds_${first}`
      });

      if (second) {
        row.push({
          text: second === totalChannels ? `Все ${second}` : `${second} раундов`,
          callback_data: `rounds_${second}`
        });
      } else {
        row.push({ text: ' ', callback_data: 'noop' });
      }

      inlineKeyboard.push(row);
    }

    await ctx.reply(
      '🎮 Выбери, сколько раундов хочешь сыграть:',
      {
        reply_markup: { inline_keyboard: inlineKeyboard }
      }
    );


  } catch (err) {
    console.error(err);
    ctx.reply('❌ Ошибка при запуске игры.');
  }
});

// Выбрать другую игру — возвращает стартовое меню с выбором 'Аватарки' / 'Арты'
bot.action('choose_game', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.reply(
      '🎮 Привет! Выбери игру «Угадай писелярщика по аватарке»! или «Угадай писелярщика по его артам"\nНажми одну из кнопок ниже, чтобы начать:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Аватарки', callback_data: 'start_game' },
              { text: 'Арты', callback_data: 'start_arts' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error('Ошибка в choose_game:', err);
  }
});


// === 🚨 Общая ошибка API ===
bot.catch((err) => {
  console.error('💣 [BOT ERROR]', err);
});

bot.launch()
.then(() => console.log('✅ Бот успешно запущен!'))
.catch(err => console.error('🔴 Ошибка запуска:', err));


// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));