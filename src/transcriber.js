const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { Groq } = require('groq-sdk');

// Configure ffmpeg to use bundled static binaries
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * Get media file duration in seconds.
 */
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

/**
 * Compress any audio or video file to a lightweight mono MP3.
 * 32kbps mono is extremely efficient for Whisper API:
 * 1 hour of audio is only ~14.4MB, which fits comfortably under the 25MB Groq API limit.
 */
function compressAudio(inputPath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vn',             // Disable video
        '-ac 1',           // Mono channel
        '-ar 16000',       // 16kHz sample rate (Whisper standard)
        '-ab 32k',         // 32kbps audio bitrate
        '-f mp3'           // MP3 container format
      ])
      .save(outputPath)
      .on('progress', (progress) => {
        if (onProgress && progress.percent) {
          onProgress(Math.round(progress.percent));
        }
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
}

/**
 * Split MP3 file into chunks of specified duration (in seconds).
 */
function splitAudio(inputPath, chunkDuration, outputDir) {
  return new Promise((resolve, reject) => {
    const outputPattern = path.join(outputDir, 'chunk_%03d.mp3');
    ffmpeg(inputPath)
      .outputOptions([
        '-f segment',
        `-segment_time ${chunkDuration}`,
        '-c copy' // Direct stream copy of the MP3 chunks (fast and clean)
      ])
      .save(outputPattern)
      .on('end', () => {
        const files = fs.readdirSync(outputDir)
          .filter(f => f.startsWith('chunk_') && f.endsWith('.mp3'))
          .map(f => path.join(outputDir, f))
          .sort();
        resolve(files);
      })
      .on('error', (err) => reject(err));
  });
}

/**
 * Format timestamp in seconds to SRT or VTT time formats.
 */
function formatTime(seconds, isVtt = false) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  const pad = (num, size = 2) => String(num).padStart(size, '0');
  const separator = isVtt ? '.' : ',';
  
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}${separator}${pad(ms, 3)}`;
}

/**
 * Format segments into SRT format.
 */
function segmentsToSrt(segments) {
  return segments.map((seg, idx) => {
    const startStr = formatTime(seg.start, false);
    const endStr = formatTime(seg.end, false);
    return `${idx + 1}\n${startStr} --> ${endStr}\n${seg.text.trim()}\n`;
  }).join('\n');
}

/**
 * Format segments into VTT format.
 */
function segmentsToVtt(segments) {
  const body = segments.map((seg, idx) => {
    const startStr = formatTime(seg.start, true);
    const endStr = formatTime(seg.end, true);
    return `${idx + 1}\n${startStr} --> ${endStr}\n${seg.text.trim()}\n`;
  }).join('\n');
  return `WEBVTT\n\n${body}`;
}

/**
 * Format segments into Plain Text.
 */
function segmentsToText(segments) {
  return segments.map(seg => seg.text.trim()).join(' ');
}

/**
 * Diarize transcribed audio segments using Llama3-70b via Groq's Chat Completion.
 */
async function diarizeSegments(apiKey, segments) {
  if (!segments || segments.length === 0) return segments;

  const groq = new Groq({ apiKey });
  
  // Format segments into a compact text block for the LLM
  const textBlock = segments.map(seg => {
    const timeStr = `${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s`;
    return `[${seg.id}] [${timeStr}]: ${seg.text.trim()}`;
  }).join('\n');

  const systemPrompt = `Ты — профессиональный редактор аудио-транскрипций.
Твоя задача — выполнить диаризацию (разделение по спикерам) предоставленного текста с таймкодами.
Анализируй контекст разговора, интонации и фразы, чтобы определить смену говорящих.
Раздели текст на реплики спикеров: Спикер 1, Спикер 2 и т.д. (если известны имена из контекста, можешь использовать их, например: "Дмитрий", "Алексей").

Формат входных данных:
[ID] [Start - End]: Текст сегмента

Формат выходных данных (возвращай строго в формате JSON, без лишнего текста, объяснений и разметки markdown):
{
  "segments": [
    {
      "id": ID,
      "speaker": "Спикер X или Имя"
    }
  ]
}

Важно:
1. Сохраняй исходный ID для каждого сегмента.
2. Не изменяй и не сокращай исходный текст сегментов.
3. Каждому входящему сегменту должен соответствовать элемент в выходном массиве с тем же ID.`;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Входные сегменты:\n${textBlock}` }
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });

    const content = chatCompletion.choices[0].message.content;
    const responseData = JSON.parse(content);

    if (responseData && Array.isArray(responseData.segments)) {
      const speakerMap = {};
      responseData.segments.forEach(item => {
        if (item.id !== undefined && item.speaker) {
          speakerMap[item.id] = item.speaker;
        }
      });

      segments.forEach(seg => {
        const speaker = speakerMap[seg.id];
        if (speaker) {
          seg.text = `[${speaker}] ${seg.text.trim()}`;
        }
      });
    }
  } catch (err) {
    console.error('Failed to perform speaker diarization:', err.message);
  }

  return segments;
}

/**
 * Core transcription orchestrator.
 */
async function transcribeMedia({ filePath, apiKey, language, format = 'text', diarize = false, onProgress }) {
  if (!apiKey || apiKey === 'YOUR_GROQ_API_KEY') {
    throw new Error('Groq API Key is not configured. Please add it to your .env file.');
  }

  const groq = new Groq({ apiKey });
  const tempDir = path.dirname(filePath);
  const compressedPath = path.join(tempDir, `compressed_${Date.now()}.mp3`);
  
  try {
    if (onProgress) onProgress('processing', 10);
    
    // 1. Compress the audio
    await compressAudio(filePath, compressedPath, (percent) => {
      if (onProgress) onProgress('processing', Math.round(10 + percent * 0.4)); // 10% - 50%
    });

    const stats = fs.statSync(compressedPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    let allSegments = [];
    
    if (fileSizeMB < 24) {
      // 2a. Transcribe single file
      if (onProgress) onProgress('transcribing', 60);
      
      const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(compressedPath),
        model: 'whisper-large-v3',
        response_format: 'verbose_json',
        language: language || undefined
      });
      
      allSegments = response.segments || [];
      if (allSegments.length === 0 && response.text) {
        allSegments = [{ id: 0, start: 0, end: await getDuration(compressedPath), text: response.text }];
      }
    } else {
      // 2b. File is too large, split into 30-minute chunks
      if (onProgress) onProgress('splitting', 55);
      
      const chunkDir = path.join(tempDir, `chunks_${Date.now()}`);
      fs.mkdirSync(chunkDir, { recursive: true });
      
      const chunkDuration = 1800;
      const chunks = await splitAudio(compressedPath, chunkDuration, chunkDir);
      
      if (onProgress) onProgress('transcribing', 60);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = chunks[i];
        const chunkOffset = i * chunkDuration;
        
        if (onProgress) {
          const transPercent = Math.round(60 + (i / chunks.length) * 30);
          onProgress(`transcribing_chunk`, transPercent, { current: i + 1, total: chunks.length });
        }
        
        const response = await groq.audio.transcriptions.create({
          file: fs.createReadStream(chunkPath),
          model: 'whisper-large-v3',
          response_format: 'verbose_json',
          language: language || undefined
        });
        
        const chunkSegments = response.segments || [];
        
        const offsetSegments = chunkSegments.map((seg, idx) => ({
          id: allSegments.length + idx,
          start: seg.start + chunkOffset,
          end: seg.end + chunkOffset,
          text: seg.text
        }));
        
        allSegments.push(...offsetSegments);
        
        try { fs.unlinkSync(chunkPath); } catch (e) {}
      }
      
      try { fs.rmdirSync(chunkDir); } catch (e) {}
    }

    // 2c. Optional Speaker Diarization
    if (diarize && allSegments.length > 0) {
      if (onProgress) onProgress('diarizing', 90);
      
      const chunkSize = 30;
      const totalChunks = Math.ceil(allSegments.length / chunkSize);
      
      for (let i = 0; i < allSegments.length; i += chunkSize) {
        const chunk = allSegments.slice(i, i + chunkSize);
        if (onProgress) {
          const chunkNum = Math.floor(i / chunkSize) + 1;
          onProgress('diarizing_chunk', 90, { current: chunkNum, total: totalChunks });
        }
        await diarizeSegments(apiKey, chunk);
      }
    }

    if (onProgress) onProgress('formatting', 95);
    
    // 3. Format output based on settings
    let resultText = '';
    if (format === 'srt') {
      resultText = segmentsToSrt(allSegments);
    } else if (format === 'vtt') {
      resultText = segmentsToVtt(allSegments);
    } else {
      resultText = segmentsToText(allSegments);
    }
    
    if (onProgress) onProgress('completed', 100);
    return resultText;
    
  } finally {
    // Cleanup main compressed file
    try {
      if (fs.existsSync(compressedPath)) {
        fs.unlinkSync(compressedPath);
      }
    } catch (e) {}
  }
}

module.exports = {
  transcribeMedia,
  getDuration
};
