// State Variables
let currentTab = 'file';
let selectedFile = null;
let currentJobId = null;
let pollInterval = null;
let logHistory = [];
let transcriptionResult = '';

// DOM Elements
const tabFile = document.getElementById('tab-file');
const tabLink = document.getElementById('tab-link');
const sectionFile = document.getElementById('section-file');
const sectionLink = document.getElementById('section-link');

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const selectedFileDisplay = document.getElementById('selected-file-display');
const selectedFileName = document.getElementById('selected-file-name');
const selectedFileSize = document.getElementById('selected-file-size');
const linkInput = document.getElementById('link-input');
const diarizeCheckbox = document.getElementById('diarize-checkbox');

const submitBtn = document.getElementById('submit-btn');

const viewIdle = document.getElementById('view-idle');
const viewProcessing = document.getElementById('view-processing');
const viewResult = document.getElementById('view-result');

const processingTitle = document.getElementById('processing-title');
const processingDetail = document.getElementById('processing-detail');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressPercent = document.getElementById('progress-percent');
const logOutput = document.getElementById('log-output');

const resultMetaInfo = document.getElementById('result-meta-info');
const textResultContent = document.getElementById('text-result-content');
const statChars = document.getElementById('stat-chars');
const statWords = document.getElementById('stat-words');
const statTime = document.getElementById('stat-time');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

/* Tab Switching Logic */
function switchTab(tab) {
  if (tab === currentTab) return;
  currentTab = tab;
  
  if (tab === 'file') {
    tabFile.classList.add('active');
    tabLink.classList.remove('active');
    sectionFile.classList.add('active');
    sectionLink.classList.remove('active');
  } else {
    tabLink.classList.add('active');
    tabFile.classList.remove('active');
    sectionLink.classList.add('active');
    sectionFile.classList.remove('active');
  }
}

/* Drag and Drop Handling */
dropzone.addEventListener('click', () => {
  if (!selectedFile) {
    fileInput.click();
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelection(e.target.files[0]);
  }
});

// Dragover styles
['dragenter', 'dragover'].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  }, false);
});

// Handle drop
dropzone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files.length > 0) {
    handleFileSelection(files[0]);
  }
});

function handleFileSelection(file) {
  // Simple check for audio/video mime types or extensions
  const fileType = file.type;
  const isAudio = fileType.startsWith('audio/');
  const isVideo = fileType.startsWith('video/');
  
  if (!isAudio && !isVideo) {
    showToast('Пожалуйста, выберите аудио или видеофайл.', 'danger');
    return;
  }
  
  selectedFile = file;
  
  // Update Selected File UI
  selectedFileName.textContent = file.name;
  selectedFileSize.textContent = formatBytes(file.size);
  
  // Hide dropzone content, show selected file details
  dropzone.querySelector('.dropzone-content').style.display = 'none';
  selectedFileDisplay.style.display = 'flex';
}

function clearSelectedFile(e) {
  if (e) e.stopPropagation();
  selectedFile = null;
  fileInput.value = '';
  
  // Reset dropzone UI
  dropzone.querySelector('.dropzone-content').style.display = 'flex';
  selectedFileDisplay.style.display = 'none';
}

/* Helper to format file size */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/* Logging helper */
function addLogLine(text) {
  if (logHistory.includes(text)) return;
  logHistory.push(text);
  
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = text;
  logOutput.appendChild(div);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function clearLogs() {
  logHistory = [];
  logOutput.innerHTML = '';
}

/* Start Transcription Trigger */
async function startTranscription() {
  const langSelect = document.getElementById('lang-select');
  const formatSelect = document.getElementById('format-select');
  
  const language = langSelect.value;
  const format = formatSelect.value;
  const diarize = diarizeCheckbox.checked;
  
  submitBtn.disabled = true;
  clearLogs();
  
  if (currentTab === 'file') {
    if (!selectedFile) {
      showToast('Пожалуйста, выберите файл для оцифровки.', 'danger');
      submitBtn.disabled = false;
      return;
    }
    
    // Upload file
    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('language', language);
    formData.append('format', format);
    formData.append('diarize', diarize);
    
    try {
      showState('processing');
      addLogLine('Подключение к серверу...');
      addLogLine(`Отправка файла: ${selectedFile.name}...`);
      
      const response = await fetch('/api/transcribe-file', {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (response.ok && data.jobId) {
        currentJobId = data.jobId;
        addLogLine(`Файл успешно загружен. Создана задача: ${currentJobId}`);
        startPolling(currentJobId);
      } else {
        throw new Error(data.error || 'Ошибка при загрузке файла.');
      }
    } catch (err) {
      showToast(err.message, 'danger');
      showState('idle');
      submitBtn.disabled = false;
    }
  } else {
    // URL Link transcription
    const url = linkInput.value.trim();
    if (!url) {
      showToast('Пожалуйста, введите ссылку.', 'danger');
      submitBtn.disabled = false;
      return;
    }
    
    try {
      showState('processing');
      addLogLine('Отправка запроса по ссылке...');
      
      const response = await fetch('/api/transcribe-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url, language, format, diarize })
      });
      
      const data = await response.json();
      
      if (response.ok && data.jobId) {
        currentJobId = data.jobId;
        addLogLine(`Запрос принят в обработку. Создана задача: ${currentJobId}`);
        startPolling(currentJobId);
      } else {
        throw new Error(data.error || 'Не удалось отправить ссылку.');
      }
    } catch (err) {
      showToast(err.message, 'danger');
      showState('idle');
      submitBtn.disabled = false;
    }
  }
}

/* Polling for updates */
function startPolling(jobId) {
  if (pollInterval) clearInterval(pollInterval);
  
  pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/progress/${jobId}`);
      if (!response.ok) {
        throw new Error('Задача не найдена или сервер недоступен.');
      }
      
      const job = await response.json();
      
      // Update UI Progress Info
      progressBarFill.style.width = `${job.percent}%`;
      progressPercent.textContent = `${job.percent}%`;
      
      let title = 'Обработка...';
      if (job.status === 'downloading') title = 'Скачивание источника...';
      else if (job.status === 'processing') title = 'Подготовка аудио...';
      else if (job.status === 'splitting') title = 'Разделение на части...';
      else if (job.status === 'transcribing') title = 'Оцифровка речи...';
      else if (job.status === 'transcribing_chunk') title = 'Оцифровка речи...';
      else if (job.status === 'diarizing') title = 'Разделение по спикерам...';
      else if (job.status === 'diarizing_chunk') title = 'Разделение по спикерам...';
      else if (job.status === 'formatting') title = 'Форматирование...';
      
      processingTitle.textContent = title;
      processingDetail.textContent = job.detail || 'В очереди...';
      
      if (job.detail) {
        addLogLine(job.detail);
      }
      
      // Handle completion
      if (job.status === 'completed') {
        clearInterval(pollInterval);
        transcriptionResult = job.result;
        displayResult(job);
        showState('result');
        submitBtn.disabled = false;
        showToast('Оцифровка успешно завершена!', 'success');
      } 
      // Handle failure
      else if (job.status === 'failed') {
        clearInterval(pollInterval);
        addLogLine(`❌ Ошибка: ${job.error}`);
        showToast(`Ошибка оцифровки: ${job.error}`, 'danger');
        showState('idle');
        submitBtn.disabled = false;
      }
      
    } catch (err) {
      clearInterval(pollInterval);
      showToast(`Ошибка соединения: ${err.message}`, 'danger');
      showState('idle');
      submitBtn.disabled = false;
    }
  }, 1000);
}

/* Switch active views */
function showState(state) {
  viewIdle.classList.remove('active');
  viewProcessing.classList.remove('active');
  viewResult.classList.remove('active');
  
  if (state === 'idle') {
    viewIdle.classList.add('active');
  } else if (state === 'processing') {
    viewProcessing.classList.add('active');
  } else if (state === 'result') {
    viewResult.classList.add('active');
  }
}

/* Display Finished Result details */
function displayResult(job) {
  const formatSelect = document.getElementById('format-select');
  const formatType = formatSelect.value.toUpperCase();
  
  resultMetaInfo.textContent = `${formatType} • 100%`;
  textResultContent.textContent = job.result;
  
  // Calculate Stats
  const chars = job.result.length;
  const words = job.result.trim().split(/\s+/).filter(w => w.length > 0).length;
  
  // Avg reading speed: ~150 words per minute
  const readingTime = Math.max(1, Math.round(words / 150));
  
  statChars.textContent = chars.toLocaleString();
  statWords.textContent = words.toLocaleString();
  statTime.textContent = `~${readingTime} мин.`;
}

/* Copy to Clipboard Actions */
function copyResultToClipboard() {
  if (!transcriptionResult) return;
  
  navigator.clipboard.writeText(transcriptionResult)
    .then(() => {
      showToast('Результат успешно скопирован в буфер обмена!', 'success');
    })
    .catch((err) => {
      showToast('Не удалось скопировать текст.', 'danger');
    });
}

/* Download file action */
function downloadResultFile() {
  if (!transcriptionResult) return;
  
  const formatSelect = document.getElementById('format-select');
  const format = formatSelect.value;
  const ext = format === 'text' ? 'txt' : format;
  
  const blob = new Blob([transcriptionResult], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcription_${Date.now()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Toast notifications display */
function showToast(message, type = 'success') {
  toastMessage.textContent = message;
  
  if (type === 'success') {
    toast.style.background = '#10b981';
    toast.querySelector('.toast-icon').setAttribute('data-lucide', 'check-circle');
  } else {
    toast.style.background = '#ef4444';
    toast.querySelector('.toast-icon').setAttribute('data-lucide', 'alert-circle');
  }
  
  lucide.createIcons(); // refresh icon
  
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}
