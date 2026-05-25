const fs = require('fs');

async function test() {
  const blob = new Blob([fs.readFileSync('web/public/test.mp3')], { type: 'audio/mpeg' });
  const form = new FormData();
  form.append('file', blob, 'speech.mp3');
  form.append('sessionId', 'test-js');
  form.append('wantsAudio', 'false');

  try {
    const res = await fetch('http://localhost:5173/webhook/rag-agent', {
      method: 'POST',
      body: form
    });
    console.log(res.status);
    console.log(await res.text());
  } catch (e) {
    console.error('Fetch error:', e);
  }
}
test();
