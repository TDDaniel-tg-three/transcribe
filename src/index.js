require('dotenv').config();
const { initBot } = require('./bot');
const { initServer } = require('./server');

console.log('🚀 Starting Groq-Powered Transcription Service...');

// Start Web Server
try {
  initServer();
} catch (err) {
  console.error('❌ Failed to start Web Server:', err.message);
}

// Start Telegram Bot
try {
  initBot();
} catch (err) {
  console.error('❌ Failed to start Telegram Bot:', err.message);
}
