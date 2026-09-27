const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 850,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handler: Save / Convert Video Recording
ipcMain.handle('convert-to-mp4', async (event, arrayBuffer) => {
  try {
    const { filePath } = await dialog.showSaveDialog({
      title: 'Save Recording',
      defaultPath: 'speech_recording.webm',
      filters: [{ name: 'Video Files', extensions: ['webm', 'mp4'] }]
    });

    if (filePath) {
      await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
      return { success: true, message: 'Saved successfully!' };
    }
    return { success: false, message: 'Save cancelled.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// IPC Handler: Transcribe Audio using Hugging Face Whisper AI
ipcMain.handle('transcribe-audio', async (event, { audioArrayBuffer, apiKey }) => {
  return new Promise((resolve) => {
    const cleanKey = apiKey ? apiKey.replace(/[^\x00-\x7F]/g, "").trim() : "";
    if (!cleanKey) return resolve({ success: false, error: "Please enter your Hugging Face API key." });

    const buffer = Buffer.from(audioArrayBuffer);

    const options = {
      hostname: 'router.huggingface.co',
      path: '/hf-inference/models/openai/whisper-large-v3-turbo',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cleanKey}`,
        'Content-Type': 'audio/webm',
        'Content-Length': buffer.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 503) {
            return resolve({ success: false, error: "Whisper model is warming up on free servers. Please try again in 15 seconds." });
          }
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            const errMsg = parsed.error || parsed.message || JSON.stringify(parsed);
            return resolve({ success: false, error: `Hugging Face STT Error (${res.statusCode}): ${errMsg}` });
          }
          resolve({ success: true, text: parsed.text || "" });
        } catch (e) {
          resolve({ success: false, error: "Error parsing Whisper response: " + e.message });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: "HTTPS Network Connection Error: " + e.message });
    });

    req.write(buffer);
    req.end();
  });
});

// IPC Handler: Analyze Transcript using Hugging Face Router
ipcMain.handle('analyze-speech', async (event, { transcript, apiKey, topic, referenceText, visionSummary }) => {
  return new Promise((resolve) => {
    const cleanKey = apiKey ? apiKey.replace(/[^\x00-\x7F]/g, "").trim() : "";
    if (!cleanKey) return resolve({ success: false, error: "Please enter your Hugging Face API key." });

    let contextLine = "";
    let cover1 = "topic relevance/structure";
    if (referenceText) {
      contextLine = `This is a read-aloud exercise. The speaker was asked to read this passage verbatim: "${referenceText}". Compare the transcript to the passage and note any words that seem skipped, substituted, or mispronounced, plus overall fluency.`;
      cover1 = "reading accuracy & fluency vs. the passage";
    } else if (topic) {
      contextLine = `The speaker was given this prompt to respond to: "${topic}". Also judge how well the response addressed that prompt and how well it was structured around it.`;
    }

    const visionLine = visionSummary
      ? ` Camera-based physical delivery data for this take: ${visionSummary}`
      : "";

    const coverPhysical = visionSummary ? ', (3) physical delivery (jaw/mouth control) using the camera data, (4) one concrete fix' : ', (3) one concrete fix';

    const postData = JSON.stringify({
      model: "meta-llama/Llama-3.1-8B-Instruct",
      messages: [
        {
          role: "system",
          content: `You are a speech coach. Be extremely concise: max 4 short bullet points total, no preamble, no restating the transcript. ${contextLine}${visionLine} Cover: (1) ${cover1}, (2) delivery (tone, filler words)${coverPhysical}.`
        },
        {
          role: "user",
          content: `Transcript: "${transcript}"`
        }
      ],
      max_tokens: 200
    });

    const options = {
      hostname: 'router.huggingface.co',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cleanKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 503) {
            return resolve({ success: false, error: "AI Coach model is warming up on free servers. Please try again in 15 seconds." });
          }
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            const errMsg = parsed.error?.message || parsed.error || parsed.message || JSON.stringify(parsed);
            return resolve({ success: false, error: `Hugging Face LLM Error (${res.statusCode}): ${errMsg}` });
          }
          const text = parsed.choices?.[0]?.message?.content;
          resolve({ success: true, text: text || "Response text empty." });
        } catch (e) {
          resolve({ success: false, error: "Error parsing AI Coach response: " + e.message });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: "HTTPS Network Connection Error: " + e.message });
    });

    req.write(postData);
    req.end();
  });
});