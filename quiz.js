const fs = require('fs');
const path = require('path');

module.exports = function registerQuiz({ bot, supabase, captions, artsDir }) {
  const artGames = new Map();

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

  function randomPick(arr, n) {
    const copy = arr.slice();
    const res = [];
    while (res.length < n && copy.length > 0) {
      const i = Math.floor(Math.random() * copy.length);
      res.push(copy.splice(i, 1)[0]);
    }
    return res;
  }

  async function updateQuizStatsInDb(authorUsername, authorChannelName, artIndex, isCorrect) {
    try {
      console.log('updateQuizStatsInDb called:', { authorUsername, authorChannelName, artIndex, isCorrect });
      let { data, error } = await supabase
        .from('quiz')
        .select('*')
        .eq('username', authorUsername)
        .single();

      if (error) {
        // PostgREST returns 406 / PGRST116 when no rows found for .single()
        if (error.code === 'PGRST116' || error.status === 406) {
          data = null;
          error = null;
        } else {
          console.error('Ошибка при получении записи quiz:', error);
          return;
        }
      }

        // Новая логика: считаем любое правильное угадывание как +1 в `correct`.
        const correctInc = isCorrect ? 1 : 0;
        // Больше никаких отдельных колонок для second/other — таблица содержит только
        // `correct`, `incorrect`, `all`, `percent`, `username`, `channel_name`.
      const incorrectInc = !isCorrect ? 1 : 0;
      const allInc = 1;

      if (data) {
        const newCorrect = (data.correct || 0) + correctInc;
        const newIncorrect = (data.incorrect || 0) + incorrectInc;
        const newAll = (data.all || 0) + allInc;
          const newPercent = newAll > 0 ? Math.round((newCorrect / newAll) * 100) : 0;

        const { data: updData, error: updErr } = await supabase
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
        } else {
          console.log('Quiz row updated for', authorUsername, updData);
        }
      } else {
        const correctVal = correctInc;
        const incorrectVal = incorrectInc;
        const allVal = allInc;
          const percentVal = allVal > 0 ? Math.round((correctVal / allVal) * 100) : 0;

        const { data: insData, error: insErr } = await supabase
          .from('quiz')
          .insert([
            {
              username: authorUsername,
              channel_name: authorChannelName,
              correct: correctVal,
              incorrect: incorrectVal,
              all: allVal,
              percent: percentVal
            }
          ]);
        if (insErr) {
          console.error('Ошибка при вставке quiz:', insErr);
        } else {
          console.log('Inserted new quiz row for', authorUsername, insData);
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
    // Добавляем "Все"
    keyboard.push([{ text: `Все ${totalAuthors}`, callback_data: `arts_rounds_${totalAuthors}` }]);

    await ctx.reply('🎮 Выберите количество раундов:', { reply_markup: { inline_keyboard: keyboard } });
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

      // Инициализируем игру и ожидаем выбора, сколько артов одного автора показывать
      artGames.set(userId, {
        totalRounds: rounds,
        currentRound: 0,
        score: 0,
        usedAuthors: new Set(),
        authorsMap,
        pending: 'per_count'
      });

      // Отправим выбор: 1,2,3, Все
      const keyboard = [
        [ { text: '1', callback_data: 'arts_count_1' }, { text: '2', callback_data: 'arts_count_2' } ],
        [ { text: '3', callback_data: 'arts_count_3' }, { text: 'Все', callback_data: 'arts_count_all' } ]
      ];

      await ctx.editMessageText(`🎮 Раундов: ${rounds}. Выбери, сколько артов одного автора показывать:`);
      await ctx.reply('Выбери количество пиксельартов по которым надо угадать автора - чем меньше артов тем сложнее будет угадывать. Если выберерешь "Все" то бот будет присылать от 3 до 6 артов в зависимости от автора:', { reply_markup: { inline_keyboard: keyboard } });
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
      await ctx.editMessageText(perTextTask);
      setTimeout(() => sendNextArtQuestion(ctx, userId), 500);
    } catch (err) {
      console.error('Ошибка выбора количества артов (arts_count):', err);
    }
  });

  async function sendNextArtQuestion(ctx, userId) {
    const game = artGames.get(userId);
    if (!game) return;

    const authorsKeys = Array.from(game.authorsMap.keys()).filter(a => !game.usedAuthors.has(a));
    let chosenAuthor;
    if (authorsKeys.length === 0) {
      // все использованы — сбрасываем
      game.usedAuthors.clear();
      chosenAuthor = Array.from(game.authorsMap.keys())[Math.floor(Math.random() * game.authorsMap.size)];
    } else {
      chosenAuthor = authorsKeys[Math.floor(Math.random() * authorsKeys.length)];
      game.usedAuthors.add(chosenAuthor);
    }

    const filesList = game.authorsMap.get(chosenAuthor) || [];
    const totalImages = filesList.length || 1;
    game.currentAuthor = chosenAuthor;
    game.currentFiles = filesList;
    game.currentIndex = 1;
    game.totalImages = totalImages;
    game.messageId = null;
    game.chatId = ctx.chat.id;

    // Сбрасываем прошлые варианты выбора, чтобы для каждого раунда генерировались новые опции
    game.currentChoices = null;
    game.buttonsKeyboard = null;
    game.buttonsMessageId = null;

    // Не делаем предзагрузку/кеширование всех артов — будем загружать по требованию.
    await sendArtMessage(ctx, userId);
  }

  async function buildChoices(correctUsername) {
    const captionsUsers = getCaptionsUsernames();
    // Ensure correctUsername is present and fill up to 4 unique options
    const otherCandidates = captionsUsers.filter(u => u !== correctUsername);
    const optionsSet = new Set();
    optionsSet.add(correctUsername);

    // Shuffle otherCandidates and pick until we have up to 4
    const shuffled = otherCandidates.sort(() => 0.5 - Math.random());
    for (let i = 0; i < shuffled.length && optionsSet.size < 4; i++) {
      optionsSet.add(shuffled[i]);
    }

    const options = Array.from(optionsSet);
    // Final shuffle so correct isn't always at same position
    options.sort(() => 0.5 - Math.random());
    return options;
  }

  async function sendArtMessage(ctx, userId) {
    const game = artGames.get(userId);
    if (!game) return;

    // Отправляем столько артов одного автора, сколько выбрал игрок (1,2,3 или 'all')
    let desired = game.perAuthorCount || 3;
    if (desired === 'all') desired = (game.currentFiles || []).length;
    desired = Math.max(1, Math.min((game.currentFiles || []).length, desired));
    const filesToSend = (game.currentFiles || []).slice(0, desired);
    if (!filesToSend.length) {
      return ctx.reply('Нет картинок у этого автора.');
    }

    // Сохраняем одинаковые варианты кнопок для раунда
    if (!game.currentChoices) {
      game.currentChoices = await buildChoices(game.currentAuthor);
    }
    const choices = game.currentChoices;
    const choiceButtons = choices.map(opt => ({ text: captions[opt + '.jpg'] || opt, callback_data: `arts_choose_${encodeURIComponent(opt)}` }));
    const replyMarkup = { inline_keyboard: [choiceButtons] };

    // Попробуем отправить все файлы (фото и видео) одной медиагруппой.
    const mediaAll = filesToSend.map(p => {
      const ext = path.extname(p.file).toLowerCase();
      const type = ext === '.mp4' ? 'video' : 'photo';
      return { type, media: { source: fs.createReadStream(path.join(artsDir, p.file)) } };
    });

    game.mediaMessages = [];
    let sentArray = null;
    try {
      sentArray = await bot.telegram.sendMediaGroup(game.chatId, mediaAll);
      for (let i = 0; i < sentArray.length; i++) {
        const m = sentArray[i];
        game.mediaMessages.push({ message_id: m.message_id, artIndex: filesToSend[i].index });
      }
    } catch (err) {
      console.warn('sendMediaGroup for mixed media failed, falling back to separate sends:', err && err.message ? err.message : err);
      // fallback: send videos first individually, then photos as a media group
      const photoFiles = [];
      const videoFiles = [];
      for (const f of filesToSend) {
        const ext = path.extname(f.file).toLowerCase();
        if (ext === '.mp4') videoFiles.push(f);
        else photoFiles.push(f);
      }

      // send videos individually
      for (const v of videoFiles) {
        const filePath = path.join(artsDir, v.file);
        try {
          const sent = await bot.telegram.sendVideo(game.chatId, { source: fs.createReadStream(filePath) });
          if (sent && sent.message_id) game.mediaMessages.push({ message_id: sent.message_id, artIndex: v.index });
        } catch (e) {
          console.error('Ошибка при отправке видео:', e);
        }
      }

      // send photos as media group
      if (photoFiles.length > 0) {
        const media = photoFiles.map(p => ({ type: 'photo', media: { source: fs.createReadStream(path.join(artsDir, p.file)) } }));
        try {
          const sentPhotos = await bot.telegram.sendMediaGroup(game.chatId, media);
          for (let i = 0; i < sentPhotos.length; i++) {
            const m = sentPhotos[i];
            game.mediaMessages.push({ message_id: m.message_id, artIndex: photoFiles[i].index });
          }
        } catch (err2) {
          console.error('Ошибка при отправке медиагруппы фото (fallback):', err2);
          for (const p of photoFiles) {
            try {
              const sent = await ctx.replyWithPhoto({ source: fs.createReadStream(path.join(artsDir, p.file)) });
              if (sent && sent.message_id) game.mediaMessages.push({ message_id: sent.message_id, artIndex: p.index });
            } catch (e) {
              console.error('fallback send photo:', e);
            }
          }
        }
      }
    }

    // Теперь отправим одно сообщение с вариантами — каждая кнопка на отдельной строке
    const primaryArt = filesToSend[0];
    const artIdx = primaryArt.index;
    const choiceRows = choices.map(opt => [ { text: captions[opt + '.jpg'] || opt, callback_data: `arts_choose_${artIdx}_${encodeURIComponent(opt)}` } ]);

    try {
      const buttonsMsg = await ctx.reply('Выбери автора для этих артов', { reply_markup: { inline_keyboard: choiceRows } });
      if (buttonsMsg && buttonsMsg.message_id) {
        game.buttonsMessageId = buttonsMsg.message_id;
        game.buttonsKeyboard = choiceRows;
        game.primaryArtIndex = artIdx;
      }
    } catch (err) {
      console.error('Ошибка при отправке сообщения с кнопками:', err);
    }
  }

  // Removed navigation handlers — we send three images at once now.

  bot.action(/^arts_choose_(\d+)_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const match = ctx.callbackQuery.data.match(/^arts_choose_(\d+)_(.+)$/);
      const artIndex = parseInt(match[1], 10);
      const selected = decodeURIComponent(match[2]);
      const userId = ctx.from.id;
      const game = artGames.get(userId);
      if (!game) return;

      // Убираем кнопки
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (e) {
        // ignore
      }

      const correct = game.currentAuthor;
      const channelName = captions[correct + '.jpg'] || correct;
      if (selected === correct) {
        game.score++;
        await ctx.reply(`🎉 Правильно, автор @${correct}`);
        await updateQuizStatsInDb(correct, channelName, artIndex, true);
      } else {
        await ctx.reply(`❌ Неверно, автор арта @${correct}`);
        await updateQuizStatsInDb(correct, channelName, artIndex, false);
      }

      // Отключаем кнопки в сообщении с кнопками (заменяем клавиатуру на пустую)
      try {
        if (game && game.buttonsMessageId) {
          try {
            await bot.telegram.editMessageReplyMarkup(game.chatId, game.buttonsMessageId, null, { inline_keyboard: [] });
          } catch (e) {
            // ignore edit errors
          }
        }
      } catch (e) {
        // ignore
      }

      game.currentRound++;

      const remaining = Math.max(0, game.totalRounds - game.currentRound);
      const correctCount = game.score || 0;
      await ctx.reply(`Пройдено: ${game.currentRound}. Правильных: ${correctCount} Осталось: ${remaining}`);

      if (game.currentRound >= game.totalRounds) {
        const perText = game.perAuthorCount === 'all'
          ? 'При всех доступных артах'
          : `Количество доступных артов на каждого художника: ${game.perAuthorCount}`;

        const finalMsg = `🏁 Игра окончена! Твой результат: ${game.score} из ${game.totalRounds}\n${perText}`;

        await ctx.reply(finalMsg, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔁 Играть снова', callback_data: 'arts_play_again' },
                { text: 'Выбрать другую игру', callback_data: 'choose_game' }
              ]
            ]
          }
        });
        artGames.delete(userId);
        return;
      }

      // Небольшая пауза и следующий вопрос
      setTimeout(() => sendNextArtQuestion(ctx, userId), 900);
    } catch (err) {
      console.error('Ошибка при выборе автора (arts):', err);
    }
  });

    // Обработчик кнопки 'Играть снова' для артов
    bot.action('arts_play_again', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await sendRoundsSelection(ctx);
      } catch (err) {
        console.error('Ошибка arts_play_again:', err);
      }
    });
};
