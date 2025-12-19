const fs = require('fs');
const path = require('path');
const { TelegramError } = require('telegraf');

module.exports = function registerQuiz({ bot, supabase, captions, artsDir }) {
  const artGames = new Map();

  // === Универсальная функция повтора с экспоненциальной задержкой ===
  async function retryOnRateLimit(fn, retries = 5, { ignore403 = false } = {}) {
    let lastError;
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof TelegramError) {
          // Ошибка 403 — пользователь заблокировал бота
          if (err.code === 403) {
            console.warn(`❌ Пользователь заблокировал бота. Невозможно отправить сообщение.`);
            if (ignore403) {
              throw new Error('USER_BLOCKED');
            }
            throw err;
          }

          // Ошибка 429 — Too Many Requests
          if (err.code === 429) {
            const retryAfter = err.parameters?.retry_after || 1;
            console.warn(`⚠️ Too Many Requests. Ждём ${retryAfter} сек.`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }
        }
        throw err; // все остальные ошибки пробрасываем
      }
    }
    throw lastError;
  }

  // Сбор авторов и их артов из папки arts
  function buildAuthorsMap() {
    const authors = new Map();
    if (!fs.existsSync(artsDir)) return authors;
    const files = fs.readdirSync(artsDir);
    for (const file of files) {
      const match = file.match(/^(.+?)#(\d+)\.(jpg|jpeg|png|webp|mp4)$/i);
      if (!match) continue;
      const username = match[1];
      const index = parseInt(match[2], 10);
      if (!authors.has(username)) authors.set(username, []);
      authors.get(username).push({ file, index });
    }
    // Сортируем по индексу
    for (const [username, list] of authors.entries()) {
      list.sort((a, b) => a.index - b.index);
    }
    return authors;
  }

  function getCaptionsUsernames() {
    return Object.keys(captions).map(k => path.basename(k, path.extname(k)));
  }

  // Получаем статистику всех авторов из базы
  async function getAuthorStatsFromDb() {
    try {
      const { data, error } = await supabase
        .from('quiz')
        .select('username, all');

      if (error) {
        console.error('Ошибка при получении статистики авторов:', error);
        return new Map();
      }

      const stats = new Map();
      data.forEach(row => {
        stats.set(row.username, row.all || 0);
      });
      return stats;
    } catch (err) {
      console.error('Ошибка в getAuthorStatsFromDb:', err);
      return new Map();
    }
  }


  async function updateQuizStatsInDb(authorUsername, authorChannelName, artIndex, isCorrect) {
    try {
      let { data, error } = await supabase
        .from('quiz')
        .select('*')
        .eq('username', authorUsername)
        .single();

      if (error && error.code !== 'PGRST116' && error.status !== 406) {
        console.error('Ошибка при получении quiz:', error);
        return;
      }

      const correctInc = isCorrect ? 1 : 0;
      const incorrectInc = !isCorrect ? 1 : 0;
      const allInc = 1;

      if (data) {
        const newCorrect = (data.correct || 0) + correctInc;
        const newIncorrect = (data.incorrect || 0) + incorrectInc;
        const newAll = (data.all || 0) + allInc;
        const newPercent = newAll > 0 ? Math.round((newCorrect / newAll) * 100) : 0;

        const { error: updErr } = await supabase
          .from('quiz')
          .update({
            channel_name: authorChannelName,
            correct: newCorrect,
            incorrect: newIncorrect,
            all: newAll,
            percent: newPercent
          })
          .eq('username', authorUsername);

        if (updErr) {
          console.error('Ошибка при обновлении quiz:', updErr);
        }
      } else {
        const percentVal = allInc > 0 ? Math.round((correctInc / allInc) * 100) : 0;

        const { error: insErr } = await supabase
          .from('quiz')
          .insert([
            {
              username: authorUsername,
              channel_name: authorChannelName,
              correct: correctInc,
              incorrect: incorrectInc,
              all: allInc,
              percent: percentVal
            }
          ]);

        if (insErr) {
          console.error('Ошибка при вставке quiz:', insErr);
        }
      }
    } catch (err) {
      console.error('Ошибка при обновлении quiz в supabase:', err);
    }
  }

  // Отправка выбора кол-ва раундов
  async function sendRoundsSelection(ctx) {
    const authorsMap = buildAuthorsMap();
    const totalAuthors = authorsMap.size || 1;
    const options = [5, 20, 40];
    const keyboard = [];
    for (const opt of options) {
      keyboard.push([{ text: `${opt}`, callback_data: `arts_rounds_${opt}` }]);
    }
    keyboard.push([{ text: `Все ${totalAuthors}`, callback_data: `arts_rounds_${totalAuthors}` }]);

    try {
      await retryOnRateLimit(
        () => ctx.reply('🎮 Выберите количество раундов:', { reply_markup: { inline_keyboard: keyboard } }),
        5,
        { ignore403: true }
      );
    } catch (err) {
      if (err.message === 'USER_BLOCKED') {
        const userId = ctx.from.id;
        console.log(`[Quiz] Игрок ${userId} заблокировал бота при старте. Игра не начата.`);
        artGames.delete(userId);
        return;
      }
      console.error('Не удалось отправить выбор раундов:', err);
    }
  }

  bot.command('quiz', async (ctx) => {
    await sendRoundsSelection(ctx);
  });

  bot.action('start_arts', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await sendRoundsSelection(ctx);
    } catch (err) {
      console.error('Ошибка start_arts:', err);
    }
  });

  bot.action(/^arts_rounds_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const match = ctx.callbackQuery.data.match(/arts_rounds_(\d+)/);
      const rounds = parseInt(match[1], 10);
      const userId = ctx.from.id;

      const authorsMap = buildAuthorsMap();
      if (authorsMap.size === 0) {
        return ctx.reply('❌ В папке arts нет подходящих картинок!');
      }

      // 🚀 Загружаем статистику ОДИН РАЗ при старте игры
      const stats = await getAuthorStatsFromDb();

      artGames.set(userId, {
        totalRounds: rounds,
        currentRound: 0,
        score: 0,
        usedAuthors: new Set(),
        authorsMap,
        authorStats: stats, // ✅ Сохраняем в игру
        pending: 'per_count'
      });


      const keyboard = [
        [{ text: '1', callback_data: 'arts_count_1' }, { text: '2', callback_data: 'arts_count_2' }],
        [{ text: '3', callback_data: 'arts_count_3' }, { text: 'Все', callback_data: 'arts_count_all' }]
      ];

      try {
        await retryOnRateLimit(
          () => ctx.editMessageText(`🎮 Раундов: ${rounds}. Выбери, сколько артов одного автора показывать:`),
          5,
          { ignore403: true }
        );
      } catch (err) {
        if (err.message === 'USER_BLOCKED') {
          artGames.delete(userId);
          return;
        }
      }

      try {
        await retryOnRateLimit(
          () => ctx.reply('Выбери количество пиксельартов по которым надо угадать автора - чем меньше артов тем сложнее будет угадывать. Если выберерешь "Все" то бот будет присылать от 3 до 6 артов в зависимости от автора:', {
            reply_markup: { inline_keyboard: keyboard }
          }),
          5,
          { ignore403: true }
        );
      } catch (err) {
        if (err.message === 'USER_BLOCKED') {
          artGames.delete(userId);
          return;
        }
      }
    } catch (err) {
      console.error('Ошибка выбора раундов (arts):', err);
    }
  });

  // Обработчик выбора количества артов одного автора
  bot.action(/^arts_count_(\d+|all)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const match = ctx.callbackQuery.data.match(/arts_count_(\d+|all)/);
      let count = match[1];
      const userId = ctx.from.id;
      const game = artGames.get(userId);
      if (!game || game.pending !== 'per_count') return;

      if (count === 'all') {
        game.perAuthorCount = 'all';
      } else {
        game.perAuthorCount = Math.max(1, Math.min(3, parseInt(count, 10)));
      }

      game.pending = null;

      const perTextTask = game.perAuthorCount === 'all'
        ? 'Задача: угадать автора арта по всем доступным артам'
        : `Задача: угадать автора арта по ${game.perAuthorCount} артам`;

      try {
        await retryOnRateLimit(
          () => ctx.editMessageText(perTextTask),
          5,
          { ignore403: true }
        );
      } catch (err) {
        if (err.message === 'USER_BLOCKED') {
          artGames.delete(userId);
          return;
        }
      }

      setTimeout(() => sendNextArtQuestion(ctx, userId), 500);
    } catch (err) {
      console.error('Ошибка выбора количества артов (arts_count):', err);
    }
  });

  async function sendNextArtQuestion(ctx, userId) {
    const game = artGames.get(userId);
    if (!game) return;

    const authorsMap = game.authorsMap;
    const allAuthors = Array.from(authorsMap.keys());
    const usedAuthors = game.usedAuthors;

    let chosenAuthor;

    const availableAuthors = allAuthors.filter(a => !usedAuthors.has(a));

    if (game.currentRound < 5 && availableAuthors.length > 0) {
      // ✅ Используем статистику, загруженную при старте
      const stats = game.authorStats;

      // Добавляем авторов без статистики
      allAuthors.forEach(username => {
        if (!stats.has(username)) {
          stats.set(username, 0);
        }
      });

      // Сортируем по частоте показов
      availableAuthors.sort((a, b) => (stats.get(a) || 0) - (stats.get(b) || 0));
      chosenAuthor = availableAuthors[0];
    } else {
      if (availableAuthors.length === 0) {
        game.usedAuthors.clear();
        const remaining = allAuthors.filter(a => a !== game.currentAuthor);
        chosenAuthor = remaining.length > 0
          ? remaining[Math.floor(Math.random() * remaining.length)]
          : allAuthors[Math.floor(Math.random() * allAuthors.length)];
      } else {
        chosenAuthor = availableAuthors[Math.floor(Math.random() * availableAuthors.length)];
      }
    }

    game.usedAuthors.add(chosenAuthor);

    const filesList = authorsMap.get(chosenAuthor) || [];
    game.currentAuthor = chosenAuthor;
    game.currentFiles = filesList;
    game.totalImages = filesList.length || 1;
    game.messageId = null;
    game.chatId = ctx.chat.id;
    game.currentChoices = null;
    game.buttonsKeyboard = null;
    game.buttonsMessageId = null;

    try {
      await sendArtMessage(ctx, userId);
    } catch (err) {
      if (err.message === 'USER_BLOCKED') {
        console.log(`[Quiz] Игрок ${userId} заблокировал бота. Игра удалена.`);
        artGames.delete(userId);
        return;
      }
      console.error('Ошибка отправки арта:', err);
    }
  }

  async function buildChoices(correctUsername) {
    const captionsUsers = getCaptionsUsernames();
    const otherCandidates = captionsUsers.filter(u => u !== correctUsername);
    const optionsSet = new Set();
    optionsSet.add(correctUsername);

    const shuffled = otherCandidates.sort(() => 0.5 - Math.random());
    for (let i = 0; i < shuffled.length && optionsSet.size < 4; i++) {
      optionsSet.add(shuffled[i]);
    }

    const options = Array.from(optionsSet);
    options.sort(() => 0.5 - Math.random());
    return options;
  }

  async function sendArtMessage(ctx, userId) {
    const game = artGames.get(userId);
    if (!game) return;

    let desired = game.perAuthorCount || 3;
    if (desired === 'all') desired = (game.currentFiles || []).length;
    desired = Math.max(1, Math.min((game.currentFiles || []).length, desired));
    const filesToSend = (game.currentFiles || []).slice(0, desired);

    if (!filesToSend.length) {
      try {
        await retryOnRateLimit(
          () => ctx.reply('Нет картинок у этого автора.'),
          5,
          { ignore403: true }
        );
      } catch (err) {
        if (err.message === 'USER_BLOCKED') {
          artGames.delete(userId);
        }
      }
      return;
    }

    if (!game.currentChoices) {
      game.currentChoices = await buildChoices(game.currentAuthor);
    }
    const choices = game.currentChoices;
    const choiceRows = choices.map(opt => [
      { text: captions[opt + '.jpg'] || opt, callback_data: `arts_choose_${filesToSend[0].index}_${encodeURIComponent(opt)}` }
    ]);

    const mediaAll = filesToSend.map(p => {
      const ext = path.extname(p.file).toLowerCase();
      const type = ext === '.mp4' ? 'video' : 'photo';
      return { type, media: { source: fs.createReadStream(path.join(artsDir, p.file)) } };
    });

    game.mediaMessages = [];

    try {
      const sentArray = await retryOnRateLimit(
        () => bot.telegram.sendMediaGroup(game.chatId, mediaAll),
        5,
        { ignore403: true }
      );
      for (let i = 0; i < sentArray.length; i++) {
        game.mediaMessages.push({ message_id: sentArray[i].message_id, artIndex: filesToSend[i].index });
      }
    } catch (err) {
      if (err.message === 'USER_BLOCKED') {
        artGames.delete(userId);
        return;
      }

      console.warn('sendMediaGroup failed, falling back to individual sends:', err.message);
      const photoFiles = [];
      const videoFiles = [];
      for (const f of filesToSend) {
        const ext = path.extname(f.file).toLowerCase();
        if (ext === '.mp4') videoFiles.push(f);
        else photoFiles.push(f);
      }

      for (const v of videoFiles) {
        const filePath = path.join(artsDir, v.file);
        try {
          const sent = await retryOnRateLimit(
            () => bot.telegram.sendVideo(game.chatId, { source: fs.createReadStream(filePath) }),
            5,
            { ignore403: true }
          );
          if (sent?.message_id) {
            game.mediaMessages.push({ message_id: sent.message_id, artIndex: v.index });
          }
        } catch (e) {
          if (e.message === 'USER_BLOCKED') {
            artGames.delete(userId);
            return;
          }
        }
      }

      if (photoFiles.length > 0) {
        const media = photoFiles.map(p => ({ type: 'photo', media: { source: fs.createReadStream(path.join(artsDir, p.file)) } }));
        try {
          const sentPhotos = await retryOnRateLimit(
            () => bot.telegram.sendMediaGroup(game.chatId, media),
            5,
            { ignore403: true }
          );
          for (let i = 0; i < sentPhotos.length; i++) {
            game.mediaMessages.push({ message_id: sentPhotos[i].message_id, artIndex: photoFiles[i].index });
          }
        } catch (err2) {
          if (err2.message === 'USER_BLOCKED') {
            artGames.delete(userId);
            return;
          }
          for (const p of photoFiles) {
            try {
              const sent = await retryOnRateLimit(
                () => ctx.replyWithPhoto({ source: fs.createReadStream(path.join(artsDir, p.file)) }),
                5,
                { ignore403: true }
              );
              if (sent?.message_id) {
                game.mediaMessages.push({ message_id: sent.message_id, artIndex: p.index });
              }
            } catch (e) {
              if (e.message === 'USER_BLOCKED') {
                artGames.delete(userId);
                return;
              }
            }
          }
        }
      }
    }

    try {
      const buttonsMsg = await retryOnRateLimit(
        () => ctx.reply('Выбери автора для этих артов', { reply_markup: { inline_keyboard: choiceRows } }),
        5,
        { ignore403: true }
      );
      if (buttonsMsg?.message_id) {
        game.buttonsMessageId = buttonsMsg.message_id;
        game.primaryArtIndex = filesToSend[0].index;
      }
    } catch (err) {
      if (err.message === 'USER_BLOCKED') {
        artGames.delete(userId);
        return;
      }
      console.error('Ошибка отправки кнопок выбора:', err);
    }
  }

  bot.action(/^arts_choose_(\d+)_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const game = artGames.get(userId);
    if (!game) return;

    try {
      await ctx.answerCbQuery();

      const match = ctx.callbackQuery.data.match(/^arts_choose_(\d+)_(.+)$/);
      if (!match) return;
      const artIndex = parseInt(match[1], 10);
      const selected = decodeURIComponent(match[2]);

      const correct = game.currentAuthor;
      const channelName = captions[correct + '.jpg'] || correct;

      if (selected === correct) {
        game.score++;
        try {
          await retryOnRateLimit(
            () => ctx.reply(`🎉 Правильно, автор @${correct}`),
            5,
            { ignore403: true }
          );
        } catch (err) {
          if (err.message === 'USER_BLOCKED') {
            artGames.delete(userId);
            return;
          }
        }
        await updateQuizStatsInDb(correct, channelName, artIndex, true);
      } else {
        try {
          await retryOnRateLimit(
            () => ctx.reply(`❌ Неверно, автор арта @${correct}`),
            5,
            { ignore403: true }
          );
        } catch (err) {
          if (err.message === 'USER_BLOCKED') {
            artGames.delete(userId);
            return;
          }
        }
        await updateQuizStatsInDb(correct, channelName, artIndex, false);
      }

      try {
        if (game.buttonsMessageId) {
          await retryOnRateLimit(
            () => bot.telegram.editMessageReplyMarkup(game.chatId, game.buttonsMessageId, null, { inline_keyboard: [] }),
            5,
            { ignore403: true }
          );
        }
      } catch (e) {
        if (e.message === 'USER_BLOCKED') {
          artGames.delete(userId);
          return;
        }
      }

      game.currentRound++;

      const remaining = Math.max(0, game.totalRounds - game.currentRound);
      const correctCount = game.score || 0;

      try {
        await retryOnRateLimit(
          () => ctx.reply(`Пройдено: ${game.currentRound}. Правильных: ${correctCount} Осталось: ${remaining}`),
          5,
          { ignore403: true }
        );
      } catch (err) {
        if (err.message === 'USER_BLOCKED') {
          artGames.delete(userId);
          return;
        }
      }

      if (game.currentRound >= game.totalRounds) {
        const perText = game.perAuthorCount === 'all'
          ? 'При всех доступных артах'
          : `Количество доступных артов на каждого художника: ${game.perAuthorCount}`;

        const finalMsg = `🏁 Игра окончена! Твой результат: ${game.score} из ${game.totalRounds}\n${perText}`;

        try {
          await retryOnRateLimit(
            () => ctx.reply(finalMsg, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔁 Играть снова', callback_data: 'arts_play_again' }],
                  [{ text: 'Выбрать другую игру', callback_data: 'choose_game' }]
                ]
              }
            }),
            5,
            { ignore403: true }
          );
        } catch (err) {
          if (err.message === 'USER_BLOCKED') {
            // всё равно удаляем
          }
        }
        artGames.delete(userId);
        return;
      }

      setTimeout(() => sendNextArtQuestion(ctx, userId), 300);
    } catch (err) {
      if (err.message === 'USER_BLOCKED') {
        artGames.delete(userId);
        return;
      }
      console.error('Ошибка в arts_choose:', err);
    }
  });

  bot.action('arts_play_again', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await sendRoundsSelection(ctx);
    } catch (err) {
      console.error('Ошибка arts_play_again:', err);
    }
  });
};
