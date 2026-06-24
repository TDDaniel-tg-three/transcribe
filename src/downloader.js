const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const YOUTUBE_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;
const BIN_DIR = path.join(__dirname, '../bin');
const YT_DLP_PATH = path.join(BIN_DIR, 'yt-dlp.exe');
const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const NODE_DIR = 'C:\\Users\\Master Plus\\AppData\\Local\\Programs\\node-v22.12.0-win-x64';

/**
 * Check if a URL is a YouTube link.
 */
function isYouTubeUrl(url) {
  return YOUTUBE_REGEX.test(url);
}

/**
 * Ensures yt-dlp.exe binary is downloaded and available.
 */
async function ensureYtDlp(onProgress) {
  if (fs.existsSync(YT_DLP_PATH)) {
    return YT_DLP_PATH;
  }

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  if (onProgress) onProgress(15);

  try {
    const response = await axios({
      method: 'get',
      url: YT_DLP_URL,
      responseType: 'stream',
      timeout: 60000 // 60s timeout for download
    });

    const totalLength = parseInt(response.headers['content-length'], 10) || 15000000;
    let downloadedBytes = 0;

    const writer = fs.createWriteStream(YT_DLP_PATH);
    response.data.pipe(writer);

    if (onProgress) {
      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = Math.min(99, Math.round(15 + (downloadedBytes / totalLength) * 80));
        onProgress(percent);
      });
    }

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        if (onProgress) onProgress(100);
        resolve(YT_DLP_PATH);
      });
      writer.on('error', (err) => {
        try { writer.close(); } catch (e) {}
        try { if (fs.existsSync(YT_DLP_PATH)) fs.unlinkSync(YT_DLP_PATH); } catch (e) {}
        reject(err);
      });
    });
  } catch (err) {
    throw new Error(`Failed to download yt-dlp binary: ${err.message}`);
  }
}

/**
 * Executes the yt-dlp binary to extract audio as MP3.
 */
function runYtDlp(binPath, url, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '-x',                      // Extract audio
      '--audio-format', 'mp3',   // Convert to MP3
      '-o', outputPath,          // Output path
      '--no-playlist',           // Single video only
      '--ffmpeg-location', ffmpegPath // Point to bundled ffmpeg
    ];

    // Inject Node directory into PATH so yt-dlp can use Node as its JS runtime for YouTube signature decryption
    const customEnv = {
      ...process.env,
      PATH: `${NODE_DIR};${process.env.PATH || ''}`
    };

    execFile(binPath, args, { env: customEnv }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve(outputPath);
    });
  });
}

/**
 * Universal download dispatcher.
 */
async function downloadMedia(url, outputDir, onProgress) {
  const isYoutube = isYouTubeUrl(url);
  const isSocial = url.includes('vk.com') || url.includes('tiktok.com') || url.includes('vimeo.com') || url.includes('soundcloud.com');
  
  const tempFilePath = path.join(outputDir, `download_${Date.now()}.mp3`);
  
  if (isYoutube || isSocial) {
    try {
      // 1. Ensure binary is present
      const binPath = await ensureYtDlp((percent) => {
        if (onProgress) onProgress(Math.round(percent * 0.5)); // 0% - 50%
      });

      // 2. Download and extract audio
      if (onProgress) onProgress(60);
      await runYtDlp(binPath, url, tempFilePath);
      
      if (onProgress) onProgress(100);
      return tempFilePath;
    } catch (err) {
      throw new Error(`Failed to download audio from link: ${err.message}`);
    }
  } else {
    // Direct file URL downloading (e.g. mp3/wav/mp4) using axios
    try {
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 30000 // 30s timeout
      });
      
      const totalLength = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);
      
      if (onProgress) {
        response.data.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalLength) {
            const percent = Math.min(99, Math.round((downloadedBytes / totalLength) * 100));
            onProgress(percent);
          }
        });
      }
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          if (onProgress) onProgress(100);
          resolve(tempFilePath);
        });
        writer.on('error', (err) => {
          try { writer.close(); } catch (e) {}
          reject(err);
        });
      });
    } catch (err) {
      throw new Error(`Failed to download direct link: ${err.message}`);
    }
  }
}

module.exports = {
  isYouTubeUrl,
  downloadMedia
};
