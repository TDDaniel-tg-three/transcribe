require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PROJECT_DIR = path.join(__dirname, '..');
const REPO_OWNER = 'TDDaniel-tg-three';
const REPO_NAME = 'transcribe';

// Required files to deploy
const FILES_TO_DEPLOY = [
  'package.json',
  '.env.example',
  'src/index.js',
  'src/transcriber.js',
  'src/downloader.js',
  'src/bot.js',
  'src/server.js',
  'src/public/index.html',
  'src/public/index.css',
  'src/public/app.js'
];

async function deploy() {
  const githubToken = process.env.GITHUB_TOKEN;
  const renderApiKey = process.env.RENDER_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const groqApiKey = process.env.GROQ_API_KEY;

  console.log(`🚀 Инициализация деплоя на Render через репозиторий ${REPO_OWNER}/${REPO_NAME}...\n`);

  if (!githubToken || githubToken === 'YOUR_GITHUB_TOKEN') {
    console.error('❌ Ошибка: Переменная GITHUB_TOKEN не задана в файле .env.');
    console.error('   Пожалуйста, создайте GitHub Personal Access Token (PAT) на https://github.com/settings/tokens');
    console.error('   с правами "repo" и добавьте его в .env как GITHUB_TOKEN=ваш_токен.');
    process.exit(1);
  }

  if (!renderApiKey || renderApiKey === 'YOUR_RENDER_API_KEY') {
    console.error('❌ Ошибка: Переменная RENDER_API_KEY не задана в файле .env.');
    process.exit(1);
  }

  try {
    // 1. Проверка подключения к GitHub
    console.log('🔗 [1/5] Подключение к GitHub...');
    const githubUserResponse = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `token ${githubToken}` }
    });
    console.log(`   ✅ Успешно! Подключен пользователь: ${githubUserResponse.data.login}`);

    // 2. Загрузка файлов проекта через GitHub API
    console.log(`📤 [2/5] Загрузка файлов проекта в репозиторий ${REPO_OWNER}/${REPO_NAME}...`);
    const headers = { Authorization: `token ${githubToken}` };

    for (const filePath of FILES_TO_DEPLOY) {
      const fullPath = path.join(PROJECT_DIR, filePath);
      if (!fs.existsSync(fullPath)) {
        console.warn(`   ⚠️ Предупреждение: Файл ${filePath} не найден, пропускаю...`);
        continue;
      }

      const fileContent = fs.readFileSync(fullPath);
      const base64Content = fileContent.toString('base64');
      const fileUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;

      let sha = undefined;
      try {
        // Проверяем, существует ли файл, чтобы получить его SHA (нужно для обновления)
        const fileInfo = await axios.get(fileUrl, { headers });
        sha = fileInfo.data.sha;
      } catch (e) {
        // Файл не существует, это нормально
      }

      const payload = {
        message: `Deploy ${filePath}`,
        content: base64Content
      };
      if (sha) {
        payload.sha = sha;
      }

      await axios.put(fileUrl, payload, { headers });
      console.log(`   🔸 Загружен: ${filePath}${sha ? ' (обновлен)' : ''}`);
    }
    console.log('   ✅ Все файлы успешно загружены в репозиторий!');

    // 3. Получение Owner ID от Render
    console.log('☁️ [3/5] Получение ID аккаунта Render...');
    const renderOwnersResponse = await axios.get('https://api.render.com/v1/owners', {
      headers: { Authorization: `Bearer ${renderApiKey}` }
    });

    if (!renderOwnersResponse.data || renderOwnersResponse.data.length === 0) {
      throw new Error('Не удалось найти активный Workspace на Render.');
    }
    const ownerId = renderOwnersResponse.data[0].owner.id;
    const ownerName = renderOwnersResponse.data[0].owner.name;
    console.log(`   ✅ Подключено! Workspace: ${ownerName} (ID: ${ownerId})`);

    // 4. Создание / Обновление веб-сервиса на Render
    console.log('⚙️ [4/5] Настройка веб-сервиса на Render...');
    const repoUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
    
    // Сначала проверим, не создан ли уже такой сервис на Render
    const servicesListResponse = await axios.get('https://api.render.com/v1/services', {
      headers: { Authorization: `Bearer ${renderApiKey}` }
    });
    
    const existingService = servicesListResponse.data.find(s => s.service.repo === repoUrl || s.service.name === 'groq-transcriber');
    
    let serviceUrl = '';
    let serviceDashboardUrl = '';

    if (existingService) {
      console.log(`   🔸 Сервис "groq-transcriber" уже существует. Запуск деплоя существующего сервиса...`);
      const serviceId = existingService.service.id;
      
      // Триггерим новый деплой
      await axios.post(`https://api.render.com/v1/services/${serviceId}/deploys`, {}, {
        headers: { Authorization: `Bearer ${renderApiKey}` }
      });
      
      serviceUrl = existingService.service.url;
      serviceDashboardUrl = `https://dashboard.render.com/web/${serviceId}`;
      console.log(`   ✅ Деплой успешно запущен!`);
    } else {
      console.log(`   🔸 Создание новой веб-службы на Render...`);
      const renderServicePayload = {
        type: 'web_service',
        name: 'groq-transcriber',
        ownerId: ownerId,
        repo: repoUrl,
        branch: 'main',
        autoDeploy: 'yes',
        serviceDetails: {
          env: 'node',
          buildCommand: 'npm install',
          startCommand: 'node src/index.js',
          plan: 'free',
          envVars: [
            { key: 'TELEGRAM_BOT_TOKEN', value: botToken },
            { key: 'GROQ_API_KEY', value: groqApiKey },
            { key: 'PORT', value: '10000' }
          ]
        }
      };

      const renderServiceResponse = await axios.post('https://api.render.com/v1/services', renderServicePayload, {
        headers: { 
          Authorization: `Bearer ${renderApiKey}`,
          'Content-Type': 'application/json'
        }
      });

      serviceUrl = renderServiceResponse.data.service.url;
      serviceDashboardUrl = `https://dashboard.render.com/web/${renderServiceResponse.data.service.id}`;
      console.log(`   ✅ Веб-сервис на Render успешно создан!`);
    }

    // 5. Вывод
    console.log('\n🎉 [5/5] ВСЕ ЭТАПЫ ВЫПОЛНЕНЫ УСПЕШНО!');
    console.log('==================================================');
    console.log(`🌐 Ссылка на веб-панель: ${serviceUrl}`);
    console.log(`📊 Управление на Render: ${serviceDashboardUrl}`);
    console.log('==================================================');
    console.log('ℹ️ Сборка в облаке начнется автоматически и займет 2-4 минуты.');

  } catch (err) {
    console.error('\n❌ Произошла ошибка во время деплоя:');
    if (err.response) {
      console.error(`   API Error (${err.response.status}):`, JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('   Error message:', err.message);
    }
  }
}

deploy();
