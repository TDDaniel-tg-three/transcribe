const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const transcriber = require('./transcriber');
const downloader = require('./downloader');

const SETTINGS_FILE = path.join(__dirname, '../data/settings.json');
const TEMP_DIR = path.join(__dirname, '../temp');

// Ensure directories exist
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(SETTINGS_FILE))) fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });

let userSettings = {};

// Load settings from JSON database
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load user settings:', e);
  }
}

// Save settings to JSON database
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2));
  } catch (e) {
    console.error('Failed to save user settings:', e);
  }
}

loadSettings();

const getSettings = (userId) => {
  if (!userSettings[userId]) {
    userSettings[userId] = { lang: 'auto', format: 'text', diarize: false };
    saveSettings();
  } else if (userSettings[userId].diarize === undefined) {
    userSettings[userId].diarize = false;
    saveSettings();
  }
  return userSettings[userId];
};

// Generate inline keyboard for settings
const getSettingsKeyboard = (userId) => {
  const settings = getSettings(userId);
  const langLabel = { auto: '🌐 Автоопределение', ru: '🇷🇺 Русский', en: '🇬🇧 English' }[settings.lang];
  const formatLabel = { text: '📄 Текст', srt: '🎬 SRT (Субтитры)', vtt: '🎬 VTT (Субтитры)' }[settings.format];
  const diarizeLabel = settings.diarize ? '👥 Вкл (Разделять спикеров)' : '👤 Выкл (Один голос)';
  
  return {
    inline_keyboard: [
      [
        { text: `🌐 Язык: ${langLabel}`, callback_data: 'toggle_lang' }
      ],
      [
        { text: `📄 Формат: ${formatLabel}`, callback_data: 'toggle_format' }
      ],
      [
        { text: `👥 Диаризация: ${diarizeLabel}`, callback_data: 'toggle_diarize' }
      ],
      [
        { text: '✅ Готово', callback_data: 'close_settings' }
      ]
    ]
  };
};

/**
 * Initialize and start the Telegram Bot.
 */
function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN') {
    console.warn('⚠️ Telegram Bot Token is not configured in .env. Bot features are disabled.');
    return null;
  }

  const bot = new Telegraf(token);

  // Command /start
  bot.start((ctx) => {
    const welcome = `👋 *Привет! Я сервис транскрибации аудио и видео в текст.*\n\n` +
      `Отправьте мне:\n` +
      `• 🎤 *Голосовые сообщения*\n` +
      `• 📹 *Видеосообщения* (кружочки)\n` +
      `• 🎵 *Аудио* или *Видео* файлы\n` +
      `• 🔗 *Ссылку* на YouTube или прямую ссылку на медиафайл\n\n` +
      `Я быстро переведу речь в текст с помощью искусственного интеллекта.\n\n` +
      `⚙️ Настройки: /settings`;
    
    ctx.reply(welcome, { parse_mode: 'Markdown' });
  });

  // Command /settings
  bot.command('settings', (ctx) => {
    ctx.reply('⚙️ *Настройки транскрибации*\nНастройте язык распознавания речи и формат вывода результатов:', {
      parse_mode: 'Markdown',
      reply_markup: getSettingsKeyboard(ctx.from.id)
    });
  });

  // Action toggle language
  bot.action('toggle_lang', (ctx) => {
    const settings = getSettings(ctx.from.id);
    const langs = ['auto', 'ru', 'en'];
    const nextIdx = (langs.indexOf(settings.lang) + 1) % langs.length;
    settings.lang = langs[nextIdx];
    saveSettings();

    ctx.editMessageReplyMarkup(getSettingsKeyboard(ctx.from.id)).catch(() => {});
    ctx.answerCbQuery().catch(() => {});
  });

  // Action toggle format
  bot.action('toggle_format', (ctx) => {
    const settings = getSettings(ctx.from.id);
    const formats = ['text', 'srt', 'vtt'];
    const nextIdx = (formats.indexOf(settings.format) + 1) % formats.length;
    settings.format = formats[nextIdx];
    saveSettings();

    ctx.editMessageReplyMarkup(getSettingsKeyboard(ctx.from.id)).catch(() => {});
    ctx.answerCbQuery().catch(() => {});
  });

  // Action toggle diarization
  bot.action('toggle_diarize', (ctx) => {
    const settings = getSettings(ctx.from.id);
    settings.diarize = !settings.diarize;
    saveSettings();

    ctx.editMessageReplyMarkup(getSettingsKeyboard(ctx.from.id)).catch(() => {});
    ctx.answerCbQuery().catch(() => {});
  });

  // Action close settings
  bot.action('close_settings', (ctx) => {
    ctx.editMessageText('✅ *Настройки применены!* Вы можете отправлять файлы или ссылки.', {
      parse_mode: 'Markdown'
    }).catch(() => {});
    ctx.answerCbQuery().catch(() => {});
  });

  // Common transcription handler
  async function handleMediaTranscription(ctx, fileId, fileType) {
    let statusMsg;
    let localFilePath = '';
    
    try {
      statusMsg = await ctx.reply('⏳ Получение информации о файле...');
      
      // Throttled UI status updating to avoid Telegram rate limits
      let lastUpdate = 0;
      let lastText = '';
      
      const updateStatus = async (text, force = false) => {
        const now = Date.now();
        if (text === lastText) return;
        if (force || now - lastUpdate > 1500) {
          lastText = text;
          lastUpdate = now;
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text).catch(() => {});
        }
      };

      // Get download link
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const downloadUrl = fileLink.href || fileLink.toString();
      
      await updateStatus('📥 Скачивание файла из Telegram...');
      
      const ext = fileType === 'video' || fileType === 'video_note' ? '.mp4' : '.ogg';
      localFilePath = path.join(TEMP_DIR, `telegram_${Date.now()}${ext}`);
      
      // Download file using downloader helper
      await downloader.downloadMedia(downloadUrl, TEMP_DIR, (percent) => {
        updateStatus(`📥 Скачивание файла... ${percent}%`);
      });
      // Move downloaded file to localFilePath (downloader generates its own random name)
      const downloadedFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith('download_'));
      if (downloadedFiles.length > 0) {
        const generatedPath = path.join(TEMP_DIR, downloadedFiles[0]);
        fs.renameSync(generatedPath, localFilePath);
      }

      await updateStatus('⚙️ Подготовка аудио...');

      const settings = getSettings(ctx.from.id);
      
      // Transcribe
      const textResult = await transcriber.transcribeMedia({
        filePath: localFilePath,
        apiKey: process.env.GROQ_API_KEY,
        language: settings.lang === 'auto' ? null : settings.lang,
        format: settings.format,
        diarize: settings.diarize,
        onProgress: (status, percent, details) => {
          if (status === 'processing') {
            updateStatus(`⚙️ Сжатие аудио... ${percent}%`);
          } else if (status === 'splitting') {
            updateStatus(`✂️ Разделение на фрагменты... ${percent}%`);
          } else if (status === 'transcribing') {
            updateStatus(`🤖 Оцифровка речи... ${percent}%`);
          } else if (status === 'transcribing_chunk') {
            updateStatus(`🤖 Оцифровка: часть ${details.current} из ${details.total}... ${percent}%`);
          } else if (status === 'diarizing') {
            updateStatus(`👥 Разделение по спикекам...`);
          } else if (status === 'diarizing_chunk') {
            updateStatus(`👥 Разделение по спикерам: часть ${details.current} из ${details.total}...`);
          } else if (status === 'formatting') {
            updateStatus(`📄 Форматирование результата...`);
          }
        }
      });

      await updateStatus('✅ Оцифровка завершена!');
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

      if (!textResult || textResult.trim().length === 0) {
        return ctx.reply('⚠️ В аудиозаписи не удалось распознать речь.');
      }

      // Format filename based on extension
      const formatExt = settings.format === 'text' ? 'txt' : settings.format;
      
      // Send result
      if (textResult.length <= 4000) {
        const formattedMsg = `*Результат оцифровки (${settings.format.toUpperCase()}):*\n\n${textResult}`;
        await ctx.replyWithMarkdown(formattedMsg).catch(async () => {
          // If markdown styling fails, send as plain text
          await ctx.reply(textResult);
        });
      } else {
        // Send preview and full file
        await ctx.reply(`*Результат оцифровки длинный.* Прикрепляю полный файл.\n\n*Превью:*\n${textResult.substring(0, 500)}...`, { parse_mode: 'Markdown' });
        
        const outputFilename = `transcription_${Date.now()}.${formatExt}`;
        const outputFilePath = path.join(TEMP_DIR, outputFilename);
        fs.writeFileSync(outputFilePath, textResult, 'utf8');
        
        await ctx.replyWithDocument({ source: outputFilePath, filename: `audio_text.${formatExt}` });
        
        // Cleanup transcription output file
        try { fs.unlinkSync(outputFilePath); } catch (e) {}
      }

    } catch (err) {
      console.error('Bot transcription error:', err);
      if (statusMsg) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, 
          statusMsg.message_id, 
          null, 
          `❌ Произошла ошибка при обработке: ${err.message}`
        ).catch(() => {});
      } else {
        ctx.reply(`❌ Произошла ошибка: ${err.message}`);
      }
    } finally {
      // Cleanup download file
      try {
        if (localFilePath && fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
        }
      } catch (e) {}
    }
  }

  // Handle Voice Messages
  bot.on('voice', (ctx) => {
    handleMediaTranscription(ctx, ctx.message.voice.file_id, 'voice');
  });

  // Handle Video Notes (round videos)
  bot.on('video_note', (ctx) => {
    handleMediaTranscription(ctx, ctx.message.video_note.file_id, 'video_note');
  });

  // Handle Audio Files
  bot.on('audio', (ctx) => {
    handleMediaTranscription(ctx, ctx.message.audio.file_id, 'audio');
  });

  // Handle Video Files
  bot.on('video', (ctx) => {
    handleMediaTranscription(ctx, ctx.message.video.file_id, 'video');
  });

  // Handle Document Files (if they are audio or video)
  bot.on('document', (ctx) => {
    const mime = ctx.message.document.mime_type || '';
    if (mime.startsWith('audio/') || mime.startsWith('video/')) {
      handleMediaTranscription(ctx, ctx.message.document.file_id, mime.split('/')[0]);
    } else {
      ctx.reply('⚠️ Пожалуйста, отправьте аудио, видео или голосовое сообщение.');
    }
  });

  // Handle text messages (checking for links)
  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    
    // Check if it's a URL
    if (text.startsWith('http://') || text.startsWith('https://')) {
      let statusMsg;
      let downloadedPath = '';
      
      try {
        statusMsg = await ctx.reply('⏳ Проверка ссылки...');
        
        let lastUpdate = 0;
        let lastText = '';
        const updateStatus = async (text, force = false) => {
          const now = Date.now();
          if (text === lastText) return;
          if (force || now - lastUpdate > 1500) {
            lastText = text;
            lastUpdate = now;
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text).catch(() => {});
          }
        };

        await updateStatus('📥 Подготовка к скачиванию по ссылке...');

        // Download link
        downloadedPath = await downloader.downloadMedia(text, TEMP_DIR, (percent) => {
          updateStatus(`📥 Скачивание медиа по ссылке... ${percent}%`);
        });

        await updateStatus('⚙️ Обработка аудиофайла...');

        const settings = getSettings(ctx.from.id);

        // Transcribe
        const textResult = await transcriber.transcribeMedia({
          filePath: downloadedPath,
          apiKey: process.env.GROQ_API_KEY,
          language: settings.lang === 'auto' ? null : settings.lang,
          format: settings.format,
          diarize: settings.diarize,
          onProgress: (status, percent, details) => {
            if (status === 'processing') {
              updateStatus(`⚙️ Сжатие аудио... ${percent}%`);
            } else if (status === 'splitting') {
              updateStatus(`✂️ Разделение на фрагменты... ${percent}%`);
            } else if (status === 'transcribing') {
              updateStatus(`🤖 Оцифровка речи... ${percent}%`);
            } else if (status === 'transcribing_chunk') {
              updateStatus(`🤖 Оцифровка: часть ${details.current} из ${details.total}... ${percent}%`);
            } else if (status === 'diarizing') {
              updateStatus(`👥 Разделение по спикерам...`);
            } else if (status === 'diarizing_chunk') {
              updateStatus(`👥 Разделение по спикерам: часть ${details.current} из ${details.total}...`);
            } else if (status === 'formatting') {
              updateStatus(`📄 Форматирование результата...`);
            }
          }
        });

        await updateStatus('✅ Оцифровка завершена!');
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

        if (!textResult || textResult.trim().length === 0) {
          return ctx.reply('⚠️ Не удалось извлечь речь по указанной ссылке.');
        }

        const formatExt = settings.format === 'text' ? 'txt' : settings.format;

        // Send result
        if (textResult.length <= 4000) {
          const formattedMsg = `*Результат оцифровки по ссылке (${settings.format.toUpperCase()}):*\n\n${textResult}`;
          await ctx.replyWithMarkdown(formattedMsg).catch(async () => {
            await ctx.reply(textResult);
          });
        } else {
          await ctx.reply(`*Результат оцифровки длинный.* Прикрепляю полный файл.\n\n*Превью:*\n${textResult.substring(0, 500)}...`, { parse_mode: 'Markdown' });
          
          const outputFilename = `transcription_${Date.now()}.${formatExt}`;
          const outputFilePath = path.join(TEMP_DIR, outputFilename);
          fs.writeFileSync(outputFilePath, textResult, 'utf8');
          
          await ctx.replyWithDocument({ source: outputFilePath, filename: `link_text.${formatExt}` });
          
          try { fs.unlinkSync(outputFilePath); } catch (e) {}
        }

      } catch (err) {
        console.error('Link transcription error:', err);
        if (statusMsg) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, 
            statusMsg.message_id, 
            null, 
            `❌ Ошибка при обработке ссылки: ${err.message}`
          ).catch(() => {});
        } else {
          ctx.reply(`❌ Ошибка: ${err.message}`);
        }
      } finally {
        // Cleanup download file
        try {
          if (downloadedPath && fs.existsSync(downloadedPath)) {
            fs.unlinkSync(downloadedPath);
          }
        } catch (e) {}
      }
    } else {
      ctx.reply('⚠️ Пожалуйста, отправьте мне аудио, видео или ссылку (на YouTube или медиафайл).');
    }
  });

  bot.launch()
    .then(() => {
      console.log('🤖 Telegram Bot successfully started.');
    })
    .catch((err) => {
      console.error('❌ Failed to launch Telegram Bot:', err.message);
    });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = {
  initBot
};
