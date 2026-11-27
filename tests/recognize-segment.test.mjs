import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizeSegment} from '../local-models.mjs';

const input = {asrUrl: 'http://localhost:8791', turnUrl: 'http://localhost:8792', pcm: Buffer.alloc(1600)};

test('an empty transcript releases the turn and cancels the pending acoustic request', async () => {
  let predictionSignal;
  const request = async (url, options) => {
    assert.equal(options.body, input.pcm);
    if (url.endsWith('/transcribe')) return Response.json({text: '  ', reason: 'overlap'});
    predictionSignal = options.signal;
    return new Promise((_, reject) => {
      predictionSignal.addEventListener('abort', () => reject(predictionSignal.reason), {once: true});
    });
  };
  const segment = await recognizeSegment({...input, request});
  assert.deepEqual(segment, {text: '', complete: true, reason: 'overlap'});
  assert.equal(predictionSignal.aborted, true);
  assert.equal(predictionSignal.reason.name, 'AbortError');
});

test('an ASR retry for a busy worker reuses the original turn prediction', async () => {
  let predictions = 0, attempts = 0;
  const request = async url => {
    if (url.endsWith('/predict')) {
      predictions++;
      return Response.json({complete: false, probability: 0.1});
    }
    if (++attempts === 1) return new Response('', {status: 429});
    return Response.json({text: '还有一句'});
  };
  const segment = await recognizeSegment({...input, request});
  assert.deepEqual(segment, {text: '还有一句', complete: false, reason: null});
  assert.equal(attempts, 2);
  assert.equal(predictions, 1);
});

test('a manual endpoint sends audio only to the recognizer', async () => {
  const urls = [];
  const segment = await recognizeSegment({...input, forced: true, request: async url => {
    urls.push(url);
    return Response.json({text: '说完了'});
  }});
  assert.deepEqual(urls, [input.asrUrl + '/transcribe']);
  assert.equal(segment.complete, true);
});
