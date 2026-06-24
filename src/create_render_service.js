require('dotenv').config();
const axios = require('axios');

const REPO_OWNER = 'TDDaniel-tg-three';
const REPO_NAME = 'transcribe';

async function createService() {
  const renderApiKey = process.env.RENDER_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const groqApiKey = process.env.GROQ_API_KEY;

  console.log('🚀 Настройка веб-сервиса на Render для вашего репозитория...');

  if (!renderApiKey || renderApiKey === 'YOUR_RENDER_API_KEY') {
    console.error('❌ Ошибка: RENDER_API_KEY не задан в .env.');
    process.exit(1);
  }

  try {
    // 1. Получение Owner ID
    console.log('☁️ [1/3] Подключение к Render API...');
    const ownersResponse = await axios.get('https://api.render.com/v1/owners', {
      headers: { Authorization: `Bearer ${renderApiKey}` }
    });

    if (!ownersResponse.data || ownersResponse.data.length === 0) {
      throw new Error('Не удалось найти активный Workspace на Render.');
    }
    const ownerId = ownersResponse.data[0].owner.id;
    const ownerName = ownersResponse.data[0].owner.name;
    console.log(`   ✅ Подключено! Workspace: ${ownerName} (ID: ${ownerId})`);

    // 2. Создание веб-службы
    console.log('⚙️ [2/3] Отправка запроса на создание службы...');
    const repoUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
    
    // Проверим, существует ли уже
    const servicesList = await axios.get('https://api.render.com/v1/services', {
      headers: { Authorization: `Bearer ${renderApiKey}` }
    });
    
    const existing = servicesList.data.find(s => s.service.repo === repoUrl || s.service.name === 'groq-transcriber');
    
    let serviceUrl = '';
    let serviceDashboardUrl = '';

    if (existing) {
      console.log(`   🔸 Служба "groq-transcriber" уже существует. Запуск пересборки...`);
      const serviceId = existing.service.id;
      await axios.post(`https://api.render.com/v1/services/${serviceId}/deploys`, {}, {
        headers: { Authorization: `Bearer ${renderApiKey}` }
      });
      serviceUrl = existing.service.url;
      serviceDashboardUrl = `https://dashboard.render.com/web/${serviceId}`;
    } else {
      const payload = {
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

      const response = await axios.post('https://api.render.com/v1/services', payload, {
        headers: {
          Authorization: `Bearer ${renderApiKey}`,
          'Content-Type': 'application/json'
        }
      });

      serviceUrl = response.data.service.url;
      serviceDashboardUrl = `https://dashboard.render.com/web/${response.data.service.id}`;
      console.log(`   ✅ Служба успешно создана!`);
    }

    console.log('\n🎉 [3/3] НАСТРОЙКА RENDER ЗАВЕРШЕНА!');
    console.log('==================================================');
    console.log(`🌐 Адрес веб-панели: ${serviceUrl}`);
    console.log(`📊 Управление на Render: ${serviceDashboardUrl}`);
    console.log('==================================================');
    console.log('ℹ️ Сборка начнется сразу, как только вы запушите файлы в свой репозиторий.');

  } catch (err) {
    console.error('\n❌ Ошибка настройки Render:');
    if (err.response) {
      console.error(JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
  }
}

createService();
