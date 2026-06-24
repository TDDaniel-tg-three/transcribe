const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const transcriber = require('./transcriber');
const downloader = require('./downloader');

const app = express();
const TEMP_DIR = path.join(__dirname, '../temp');
const UPLOADS_DIR = path.join(TEMP_DIR, 'uploads');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Web frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory job progress store
const jobs = {};

// Helper to update job progress
function updateJob(jobId, status, percent, detail = '', extra = null) {
  if (jobs[jobId]) {
    jobs[jobId].status = status;
    jobs[jobId].percent = percent;
    jobs[jobId].detail = detail;
    if (extra) {
      jobs[jobId] = { ...jobs[jobId], ...extra };
    }
  }
}

/**
 * Endpoint to get status of a transcription job
 */
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

/**
 * Endpoint to transcribe an uploaded file
 */
app.post('/api/transcribe-file', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const { language, format, diarize } = req.body;
  const isDiarize = diarize === 'true' || diarize === true;
  const jobId = `job_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const filePath = req.file.path;

  // Initialize job
  jobs[jobId] = {
    id: jobId,
    status: 'queued',
    percent: 0,
    detail: 'Добавлено в очередь...',
    filename: req.file.originalname,
    result: null,
    error: null
  };

  // Run processing in background
  runTranscriptionBackground(jobId, filePath, language, format, isDiarize);

  // Return job ID immediately
  res.json({ jobId });
});

/**
 * Endpoint to transcribe a link (YouTube or direct audio/video)
 */
app.post('/api/transcribe-link', (req, res) => {
  const { url, language, format, diarize } = req.body;
  const isDiarize = diarize === 'true' || diarize === true;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  const jobId = `job_link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Initialize job
  jobs[jobId] = {
    id: jobId,
    status: 'queued',
    percent: 0,
    detail: 'Добавлено в очередь...',
    filename: url,
    result: null,
    error: null
  };

  // Run downloading and processing in background
  runLinkTranscriptionBackground(jobId, url, language, format, isDiarize);

  // Return job ID immediately
  res.json({ jobId });
});

/**
 * Background transcription runner for files
 */
async function runTranscriptionBackground(jobId, filePath, language, format, diarize) {
  try {
    updateJob(jobId, 'processing', 0, 'Сжатие аудиозаписи...');
    
    const textResult = await transcriber.transcribeMedia({
      filePath,
      apiKey: process.env.GROQ_API_KEY,
      language: language === 'auto' ? null : language,
      format: format || 'text',
      diarize,
      onProgress: (status, percent, details) => {
        let detailMsg = '';
        if (status === 'processing') {
          detailMsg = `Сжатие аудио: ${percent}%`;
        } else if (status === 'splitting') {
          detailMsg = `Разделение аудио на части: ${percent}%`;
        } else if (status === 'transcribing') {
          detailMsg = `Распознавание речи: ${percent}%`;
        } else if (status === 'transcribing_chunk') {
          detailMsg = `Распознавание: часть ${details.current} из ${details.total} (${percent}%)`;
        } else if (status === 'diarizing') {
          detailMsg = `Разделение по спикерам...`;
        } else if (status === 'diarizing_chunk') {
          detailMsg = `Разделение по спикерам: часть ${details.current} из ${details.total}...`;
        } else if (status === 'formatting') {
          detailMsg = `Форматирование текста...`;
        }
        updateJob(jobId, status, percent, detailMsg);
      }
    });

    updateJob(jobId, 'completed', 100, 'Готово!', { result: textResult });
  } catch (err) {
    console.error(`Error in job ${jobId}:`, err);
    updateJob(jobId, 'failed', 0, `Ошибка: ${err.message}`, { error: err.message });
  } finally {
    // Clean up uploaded file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {}
  }
}

/**
 * Background transcription runner for links
 */
async function runLinkTranscriptionBackground(jobId, url, language, format, diarize) {
  let downloadedPath = '';
  
  try {
    updateJob(jobId, 'downloading', 0, 'Подключение к источнику...');
    
    // Download using our downloader helper
    downloadedPath = await downloader.downloadMedia(url, TEMP_DIR, (percent) => {
      updateJob(jobId, 'downloading', percent, `Скачивание медиа: ${percent}%`);
    });
    
    updateJob(jobId, 'processing', 0, 'Сжатие аудио...');

    const textResult = await transcriber.transcribeMedia({
      filePath: downloadedPath,
      apiKey: process.env.GROQ_API_KEY,
      language: language === 'auto' ? null : language,
      format: format || 'text',
      diarize,
      onProgress: (status, percent, details) => {
        let detailMsg = '';
        if (status === 'processing') {
          detailMsg = `Сжатие аудио: ${percent}%`;
        } else if (status === 'splitting') {
          detailMsg = `Разделение аудио на части: ${percent}%`;
        } else if (status === 'transcribing') {
          detailMsg = `Распознавание речи: ${percent}%`;
        } else if (status === 'transcribing_chunk') {
          detailMsg = `Распознавание: часть ${details.current} из ${details.total} (${percent}%)`;
        } else if (status === 'diarizing') {
          detailMsg = `Разделение по спикерам...`;
        } else if (status === 'diarizing_chunk') {
          detailMsg = `Разделение по спикерам: часть ${details.current} из ${details.total}...`;
        } else if (status === 'formatting') {
          detailMsg = `Форматирование текста...`;
        }
        updateJob(jobId, status, percent, detailMsg);
      }
    });

    updateJob(jobId, 'completed', 100, 'Готово!', { result: textResult });
  } catch (err) {
    console.error(`Error in job ${jobId}:`, err);
    updateJob(jobId, 'failed', 0, `Ошибка: ${err.message}`, { error: err.message });
  } finally {
    // Clean up downloaded file
    try {
      if (downloadedPath && fs.existsSync(downloadedPath)) {
        fs.unlinkSync(downloadedPath);
      }
    } catch (e) {}
  }
}

/**
 * Initialize and start the Express Server.
 */
function initServer() {
  const port = process.env.PORT || 3000;
  
  const server = app.listen(port, () => {
    console.log(`🌐 Web interface started at http://localhost:${port}`);
  });
  
  return server;
}

module.exports = {
  initServer
};
