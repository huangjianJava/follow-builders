import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { deliverDigest } from '../deliver.js';

function stdinFrom(text) {
  return Readable.from([Buffer.from(text)]);
}

async function captureConsole(fn) {
  const logs = [];
  const originalLog = console.log;
  console.log = value => logs.push(value);
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = originalLog;
  }
}

test('deliverDigest publishes stdin digest to feishu doc with injected config env and fetch', async () => {
  const config = {
    delivery: {
      method: 'feishu_doc',
      feishu: {
        appId: 'cli_test',
        folderToken: 'fld_test'
      }
    }
  };
  const env = { FEISHU_APP_SECRET: 'secret' };
  const fetchImpl = async () => {};
  const expected = {
    status: 'ok',
    method: 'feishu_doc',
    url: 'https://feishu/doc_1'
  };
  const calls = [];

  const { result, logs } = await captureConsole(() => deliverDigest({
    argv: [],
    stdin: stdinFrom('# Digest from stdin'),
    env,
    fetchImpl,
    configOverride: config,
    publishFeishuDocImpl: async (...args) => {
      calls.push(args);
      return expected;
    }
  }));

  assert.equal(result, expected);
  assert.deepEqual(calls, [
    ['# Digest from stdin', config, { env, fetch: fetchImpl }]
  ]);
  assert.deepEqual(logs, [JSON.stringify(expected, null, 2)]);
});

test('deliverDigest stdout mode returns ok and prints digest text', async () => {
  const { result, logs } = await captureConsole(() => deliverDigest({
    argv: [],
    stdin: stdinFrom('plain digest'),
    configOverride: { delivery: { method: 'stdout' } }
  }));

  assert.deepEqual(result, { status: 'ok', method: 'stdout' });
  assert.deepEqual(logs, ['plain digest']);
});

test('deliverDigest skips empty digest text', async () => {
  const { result, logs } = await captureConsole(() => deliverDigest({
    argv: [],
    stdin: stdinFrom('   \n'),
    configOverride: { delivery: { method: 'feishu_doc' } },
    publishFeishuDocImpl: async () => {
      throw new Error('publish should not be called');
    }
  }));

  const skipped = { status: 'skipped', reason: 'Empty digest text' };
  assert.deepEqual(result, skipped);
  assert.deepEqual(logs, [JSON.stringify(skipped)]);
});

test('deliverDigest uses --message argument as digest input', async () => {
  const { result, logs } = await captureConsole(() => deliverDigest({
    argv: ['--message', 'digest from argv'],
    stdin: stdinFrom('ignored stdin'),
    configOverride: { delivery: { method: 'stdout' } }
  }));

  assert.deepEqual(result, { status: 'ok', method: 'stdout' });
  assert.deepEqual(logs, ['digest from argv']);
});
