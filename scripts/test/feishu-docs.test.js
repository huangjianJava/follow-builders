import test from 'node:test';
import assert from 'node:assert/strict';
import { publishFeishuDoc, validateFeishuConfig } from '../lib/feishu-docs.js';

function createMockFetch(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      async json() {
        return next.body;
      }
    };
  };
}

const baseConfig = {
  timezone: 'Asia/Shanghai',
  delivery: {
    method: 'feishu_doc',
    feishu: {
      appId: 'cli_test',
      appSecretEnv: 'FEISHU_APP_SECRET',
      folderToken: 'fld_test',
      titleTemplate: 'AI Builders Digest - {{date}}',
      onExisting: 'update',
      includeMetadata: false
    }
  }
};

test('validateFeishuConfig requires app id secret and folder token', () => {
  assert.throws(
    () => validateFeishuConfig({ delivery: { feishu: {} } }, {}),
    /delivery.feishu.appId is required/
  );
  assert.throws(
    () => validateFeishuConfig({ delivery: { feishu: { appId: 'cli' } } }, {}),
    /FEISHU_APP_SECRET is required/
  );
  assert.throws(
    () => validateFeishuConfig(
      { delivery: { feishu: { appId: 'cli', folderToken: '' } } },
      { FEISHU_APP_SECRET: 'secret' }
    ),
    /delivery.feishu.folderToken is required/
  );
});

test('validateFeishuConfig rejects unsupported onExisting values', () => {
  assert.throws(
    () => validateFeishuConfig(
      {
        delivery: {
          feishu: {
            appId: 'cli',
            folderToken: 'fld',
            onExisting: 'create'
          }
        }
      },
      { FEISHU_APP_SECRET: 'secret' }
    ),
    /delivery.feishu.onExisting must be "update"/
  );
});

test('publishFeishuDoc creates a document when daily title is missing', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    { body: { code: 0, data: { files: [] } } },
    { body: { code: 0, data: { document: { document_id: 'doc_1', url: 'https://feishu/doc_1' } } } },
    { body: { code: 0, data: { items: [{ block_id: 'doc_1', children: [] }] } } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);

  const result = await publishFeishuDoc('# Digest', baseConfig, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.action, 'created');
  assert.equal(result.title, 'AI Builders Digest - 2026-05-28');
  assert.equal(result.url, 'https://feishu/doc_1');
  assert.equal(calls[2].url, 'https://open.feishu.cn/open-apis/docx/v1/documents');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer tenant_token');
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
});

test('publishFeishuDoc updates newest existing duplicate and warns', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    {
      body: {
        code: 0,
        data: {
          files: [
            { name: 'AI Builders Digest - 2026-05-28', type: 'docx', token: 'old_doc', url: 'https://feishu/old', modified_time: '100' },
            { name: 'AI Builders Digest - 2026-05-28', type: 'docx', token: 'new_doc', url: 'https://feishu/new', modified_time: '200' }
          ]
        }
      }
    },
    { body: { code: 0, data: { items: [{ block_id: 'new_doc', children: [{ block_id: 'child_1' }] }] } } },
    { body: { code: 0, data: {} } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);

  const result = await publishFeishuDoc('Digest body', baseConfig, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.url, 'https://feishu/new');
  assert.match(result.warnings[0], /Multiple documents/);
  assert.equal(calls[3].options.method, 'DELETE');
  assert.equal(JSON.parse(calls[3].options.body).end_index, 1);
});

test('publishFeishuDoc falls back to plain text when structured write fails', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    { body: { code: 0, data: { files: [] } } },
    { body: { code: 0, data: { document: { document_id: 'doc_1', url: 'https://feishu/doc_1' } } } },
    { body: { code: 0, data: { items: [{ block_id: 'doc_1', children: [] }] } } },
    { body: { code: 999, msg: 'bad block' } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);

  const result = await publishFeishuDoc('# Digest', baseConfig, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  assert.equal(result.fallback, 'plain_text');
  assert.match(result.warnings[0], /Structured write failed/);
  const fallbackBody = JSON.parse(calls[5].options.body);
  assert.equal(fallbackBody.children[0].block_type, 2);
  assert.equal(fallbackBody.children[0].text.elements[0].text_run.content, '# Digest');
});

test('publishFeishuDoc throws Feishu API errors', async () => {
  const fetch = createMockFetch([
    { ok: false, status: 500, body: { code: 999, msg: 'server exploded' } }
  ]);

  await assert.rejects(
    () => publishFeishuDoc('Digest', baseConfig, {
      env: { FEISHU_APP_SECRET: 'secret' },
      fetch,
      now: new Date('2026-05-27T16:30:00.000Z')
    }),
    /Feishu API error/
  );
});
