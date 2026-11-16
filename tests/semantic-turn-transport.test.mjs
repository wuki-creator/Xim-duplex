import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await sleep(10);
  }
}
const loud = Buffer.alloc(1600);
for (let i = 0; i < 800; i++) loud.writeInt16LE(6000, i * 2);
const quiet = Buffer.alloc(1600);
const startSpeech = socket => {for (let i = 0; i < 8; i++) socket.send(loud);};
const endSpeech = socket => {for (let i = 0; i < 16; i++) socket.send(quiet);};
const utterance = socket => {startSpeech(socket); endSpeech(socket);};

async function fixture(t, predictions, texts = ['前半句', '后半句']) {
  const seen = {predict:0, asr:0, predicted:0, transcribed:0};
  let app;
  const sockets = [];
  const worker = http.createServer(async (req, res) => {
    if (req.url === '/health') {res.end('{"ready":true,"model":"test-endpoint"}'); return;}
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const pcm = Buffer.concat(chunks);
    assert.ok(pcm.length > 0 && pcm.length % 2 === 0, 'worker receives PCM16 bytes');
    if (req.url === '/transcribe') {
      const text = texts[seen.asr++] || '后续语句';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({text})); seen.transcribed++; return;
    }
    if (req.url === '/predict') {
      const prediction = predictions[seen.predict++] || {complete:true, probability:.9};
      if (prediction === '500') {res.writeHead(500); res.end('{}');}
      else if (prediction === 'malformed') {res.end('not-json');}
      else if (prediction === 'disconnect') {res.destroy();}
      else {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(prediction));}
      seen.predicted++; return;
    }
    res.writeHead(404); res.end();
  });
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (app && app.exitCode === null && app.signalCode === null) {
      const stopped = once(app, 'exit', {signal:AbortSignal.timeout(3000)}).catch(() => {});
      app.kill(); await stopped;
    }
    worker.closeAllConnections();
    await new Promise(resolve => worker.close(resolve));
  });
  worker.listen(0, '127.0.0.1');
  await once(worker, 'listening', {signal:AbortSignal.timeout(3000)});
  const local = 'http://127.0.0.1:' + worker.address().port;
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening', {signal:AbortSignal.timeout(3000)});
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  app = spawn(process.execPath, ['server.mjs'], {
    cwd:new URL('..', import.meta.url),
    env:{...process.env, PORT:String(port), ASR_URL:local, XIM_TURN_URL:local,
      XIM_LOCAL_CHAT_URL:local, XIM_LOCAL_CHAT_MODEL:'test-chat',
      XIM_LOCAL_TTS_URL:local, XIM_LOCAL_TTS_MODEL:'test-tts', XIM_LOCAL_VOICE:'test',
      XIM_LOCAL_IMAGE_URL:local, XIM_LOCAL_IMAGE_MODEL:'test-image', XIM_COMPUTE_URL:local},
    stdio:['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', () => {});
  await once(app.stdout, 'data', {signal:AbortSignal.timeout(5000)});
  const base = 'http://127.0.0.1:' + port;
  const boot = await fetch(base + '/api/bootstrap', {signal:AbortSignal.timeout(3000)}).then(res => res.json());
  assert.equal(boot.turnReady, true);
  assert.equal(boot.turnModel, 'test-endpoint');
  async function connect() {
    const events = [];
    const socket = new WebSocket(base.replace('http', 'ws') + '/api/voice', {origin:base});
    sockets.push(socket);
    socket.on('message', data => events.push(JSON.parse(data)));
    await once(socket, 'open', {signal:AbortSignal.timeout(3000)});
    socket.send(JSON.stringify({token:boot.token}));
    await until(() => events.some(event => event.type === 'ready'), 'voice did not become ready');
    return {socket, events, transcripts:() => events.filter(event => event.type === 'transcript')};
  }
  return {seen, connect};
}

test('semantic endpoint waits across a hesitation and joins resumed speech', {timeout:15000}, async t => {
  const f = await fixture(t, [{complete:false, probability:.12}, {complete:true, probability:.93}]);
  const {socket, events, transcripts} = await f.connect();
  utterance(socket);
  await until(() => f.seen.predicted === 1 && f.seen.transcribed === 1, 'first inference did not finish');
  await sleep(120);
  assert.equal(transcripts().length, 0, 'incomplete prediction keeps a short hesitation open');
  startSpeech(socket);
  await until(() => events.filter(event => event.type === 'speech.start').length === 2, 'resumed speech not observed');
  await sleep(1500);
  assert.equal(transcripts().length, 0, 'the old grace timer cannot release while resumed speech is active');
  endSpeech(socket);
  await until(() => transcripts().length === 1, 'the complete second segment was not released');
  assert.deepEqual(transcripts().map(event => event.text), ['前半句 后半句']);
  assert.equal(f.seen.predict, 2);
});

test('turn prediction failures fall back to the existing VAD transcript', {timeout:20000}, async t => {
  for (const failure of ['500', 'malformed', 'disconnect', {complete:false, probability:2}]) {
    await t.test(typeof failure === 'string' ? failure : 'invalid probability', {timeout:5000}, async st => {
      const f = await fixture(st, [failure]);
      const {socket, transcripts} = await f.connect();
      utterance(socket);
      await until(() => transcripts().length === 1, 'failed endpoint blocked the VAD transcript');
      assert.equal(transcripts()[0].text, '前半句');
      assert.equal(f.seen.predict, 1);
    });
  }
});

test('manual finish releases a waiting semantic turn and bypasses prediction for an active utterance', {timeout:10000}, async t => {
  const f = await fixture(t, [{complete:false, probability:.1}]);
  const {socket, events, transcripts} = await f.connect();
  utterance(socket);
  await until(() => f.seen.predicted === 1 && f.seen.transcribed === 1, 'incomplete segment not processed');
  await sleep(120);
  assert.equal(transcripts().length, 0);
  socket.send(JSON.stringify({type:'speech.finish'}));
  await until(() => transcripts().length === 1, 'manual finish did not release the held transcript');
  assert.equal(transcripts()[0].text, '前半句');
  startSpeech(socket);
  await until(() => events.filter(event => event.type === 'speech.start').length === 2, 'active utterance not observed');
  socket.send(JSON.stringify({type:'speech.finish'}));
  await until(() => transcripts().length === 2, 'manual finish did not flush the active utterance');
  assert.equal(transcripts()[1].text, '后半句');
  assert.equal(f.seen.predict, 1, 'explicit endpoint bypasses the acoustic predictor');
});

test('closing a socket cancels its held turn and cannot leak into a new voice session', {timeout:10000}, async t => {
  const f = await fixture(t, [{complete:false, probability:.1}, {complete:true, probability:.9}]);
  const first = await f.connect();
  utterance(first.socket);
  await until(() => f.seen.predicted === 1 && f.seen.transcribed === 1, 'held segment not processed');
  await sleep(120);
  assert.equal(first.transcripts().length, 0);
  const closed = once(first.socket, 'close', {signal:AbortSignal.timeout(3000)});
  first.socket.close(); await closed;
  const second = await f.connect();
  await sleep(1500);
  assert.equal(first.transcripts().length, 0, 'closed socket received no delayed transcript');
  assert.equal(second.transcripts().length, 0, 'new socket did not inherit a stale turn');
  utterance(second.socket);
  await until(() => second.transcripts().length === 1, 'new session did not release its own utterance');
  assert.equal(second.transcripts()[0].text, '后半句');
});
