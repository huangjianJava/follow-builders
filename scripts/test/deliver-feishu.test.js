import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { deliverDigest, formatDeliveryError, isCliEntrypoint } from '../deliver.js';

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

test('formatDeliveryError includes delivery method in error JSON', () => {
  assert.deepEqual(
    formatDeliveryError(new Error('publish failed'), 'feishu_doc'),
    { status: 'error', method: 'feishu_doc', message: 'publish failed' }
  );
});

test('deliverDigest logs method when feishu doc delivery fails', async () => {
  const error = new Error('publish failed');
  const { result, logs } = await captureConsole(async () => {
    try {
      await deliverDigest({
        argv: ['--message', 'digest from argv'],
        configOverride: { delivery: { method: 'feishu_doc' } },
        publishFeishuDocImpl: async () => {
          throw error;
        }
      });
      return { thrown: undefined };
    } catch (err) {
      return { thrown: err };
    }
  });

  assert.equal(result.thrown, error);
  assert.deepEqual(logs, [
    JSON.stringify({ status: 'error', method: 'feishu_doc', message: 'publish failed' })
  ]);
});

test('isCliEntrypoint is false when argv path is missing', () => {
  assert.equal(isCliEntrypoint(undefined, import.meta.url), false);
});

test('deliverDigest logs method when file input cannot be read', async () => {
  const { result, logs } = await captureConsole(async () => {
    try {
      await deliverDigest({
        argv: ['--file', '/path/that/does/not/exist.md'],
        stdin: stdinFrom('ignored stdin'),
        configOverride: { delivery: { method: 'stdout' } }
      });
      return { thrown: undefined };
    } catch (err) {
      return { thrown: err };
    }
  });

  assert.match(result.thrown.message, /ENOENT/);
  assert.deepEqual(JSON.parse(logs[0]), {
    status: 'error',
    method: 'stdout',
    message: result.thrown.message
  });
});
