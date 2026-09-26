// Quick standalone test for the Hugging Face router call.
// Usage: node test-hf.js YOUR_HF_TOKEN
//
// This hits the exact same endpoint main.js uses, so you can confirm
// your key + model work before wiring it back into the Electron app.

const https = require('https');

const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node test-hf.js YOUR_HF_TOKEN');
  process.exit(1);
}

const model = process.argv[3] || 'meta-llama/Llama-3.1-8B-Instruct';

const postData = JSON.stringify({
  model,
  messages: [
    { role: 'system', content: 'You are an expert speech coach.' },
    { role: 'user', content: 'Analyze this speech transcript: "Um, so, like, today I want to talk about, uh, climate change."' }
  ],
  max_tokens: 200
});

const options = {
  hostname: 'router.huggingface.co',
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log(`Testing model: ${model}`);

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (e) => console.error('Network error:', e.message));
req.write(postData);
req.end();