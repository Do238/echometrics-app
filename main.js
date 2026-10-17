const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { getTemplate } = require('./src/shared/templates');
const localAI = require('./src/main/local-ai');

let mainWindow;

// Where downloaded AI models are stored (e.g. C:\Users\you\AppData\Roaming\echometrics-app\models)
const modelCacheDir = () => path.join(app.getPath('userData'), 'models');

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

  // Start loading Whisper in the background so the first take isn't slow.
  // The first run ever also downloads the model (~150 MB) into the app's data folder.
  localAI.getTranscriber(modelCacheDir()).catch((e) => console.error('Whisper failed to load:', e));

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

// IPC Handler: Transcribe Audio with Whisper, running locally
ipcMain.handle('transcribe-audio', async (event, { audioArrayBuffer }) => {
  try {
    const text = await localAI.transcribe(Buffer.from(audioArrayBuffer), modelCacheDir());
    return { success: true, text };
  } catch (e) {
    console.error('Transcription failed:', e);
    return { success: false, error: 'Local Whisper error: ' + e.message };
  }
});

// IPC Handler: Analyze Transcript with the AI coach, running locally in Ollama
ipcMain.handle('analyze-speech', async (event, { transcript, topic, referenceText, visionSummary, templateId }) => {
  const template = getTemplate(templateId);

  let contextLine = "";
  let cover1 = "topic relevance/structure";
  if (referenceText) {
    contextLine = `This is a read-aloud exercise. The speaker was asked to read this passage verbatim: "${referenceText}". Compare the transcript to the passage and note any words that seem skipped, substituted, or mispronounced, plus overall fluency.`;
    cover1 = "reading accuracy & fluency vs. the passage";
  } else if (topic) {
    contextLine = `The speaker was given this prompt to respond to: "${topic}". Also judge how well the response addressed that prompt and how well it was structured around it.`;
  }

  // Speech-mode criteria (Practice tab only; read-aloud ignores the mode)
  const modeLine = (!referenceText && template.coachFocus) ? ` ${template.coachFocus}` : "";

  const visionLine = visionSummary
    ? ` Camera-based physical delivery data for this take: ${visionSummary}`
    : "";

  const coverPhysical = visionSummary ? ', (3) physical delivery (jaw/mouth control) using the camera data, (4) one concrete fix' : ', (3) one concrete fix';

  const messages = [
    {
      role: "system",
      content: `You are a speech coach. Be extremely concise: max 4 short bullet points total, no preamble, no restating the transcript. ${contextLine}${modeLine}${visionLine} Cover: (1) ${cover1}, (2) delivery (tone, filler words)${coverPhysical}.`
    },
    {
      role: "user",
      content: `Transcript: "${transcript}"`
    }
  ];

  try {
    const text = await localAI.chat(messages, 200);
    return { success: true, text: text || "Response text empty." };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Storytelling course: AI coach feedback for course recordings
require('./src/main/course-ipc').register(ipcMain);