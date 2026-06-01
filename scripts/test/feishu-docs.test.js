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
        if (next.jsonError) throw new Error(next.jsonError);
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
  assert.equal(result.method, 'feishu_doc');
  assert.equal(result.action, 'created');
  assert.equal(result.title, 'AI Builders Digest - 2026-05-28');
  assert.equal(result.url, 'https://feishu/doc_1');
  assert.equal(calls[2].url, 'https://open.feishu.cn/open-apis/docx/v1/documents');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer tenant_token');
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
});

test('publishFeishuDoc uses feishu timezone before global timezone', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    { body: { code: 0, data: { files: [] } } },
    { body: { code: 0, data: { document: { document_id: 'doc_tz', url: 'https://feishu/doc_tz' } } } },
    { body: { code: 0, data: { items: [{ block_id: 'doc_tz', children: [] }] } } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);
  const config = {
    ...baseConfig,
    timezone: 'Asia/Shanghai',
    delivery: {
      ...baseConfig.delivery,
      feishu: {
        ...baseConfig.delivery.feishu,
        timezone: 'America/Los_Angeles',
        includeMetadata: true
      }
    }
  };

  const result = await publishFeishuDoc('Digest body', config, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-28T01:30:00.000Z')
  });

  assert.equal(result.title, 'AI Builders Digest - 2026-05-27');
  const createBody = JSON.parse(calls[4].options.body);
  assert.equal(
    createBody.children[0].text.elements[0].text_run.content,
    'Generated at: 2026-05-27 18:30 America/Los_Angeles'
  );
});

test('publishFeishuDoc includes metadata when includeMetadata is omitted', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    { body: { code: 0, data: { files: [] } } },
    { body: { code: 0, data: { document: { document_id: 'doc_meta', url: 'https://feishu/doc_meta' } } } },
    { body: { code: 0, data: { items: [{ block_id: 'doc_meta', children: [] }] } } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);
  const { includeMetadata, ...feishuWithoutMetadata } = baseConfig.delivery.feishu;
  const config = {
    ...baseConfig,
    delivery: {
      ...baseConfig.delivery,
      feishu: feishuWithoutMetadata
    }
  };

  await publishFeishuDoc('Digest body', config, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  const createBody = JSON.parse(calls[4].options.body);
  assert.match(createBody.children[0].text.elements[0].text_run.content, /^Generated at:/);
  assert.equal(createBody.children[1].text.elements[0].text_run.content, 'Source: follow-builders');
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
  assert.equal(result.method, 'feishu_doc');
  assert.equal(result.url, 'https://feishu/new');
  assert.match(result.warnings[0], /Multiple documents/);
  assert.equal(calls[3].options.method, 'DELETE');
  assert.equal(JSON.parse(calls[3].options.body).end_index, 1);
});

test('publishFeishuDoc selects newest duplicate by created_time when modified_time is missing', async () => {
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    {
      body: {
        code: 0,
        data: {
          files: [
            { name: 'AI Builders Digest - 2026-05-28', type: 'docx', token: 'old_created', url: 'https://feishu/old-created', created_time: '100' },
            { name: 'AI Builders Digest - 2026-05-28', type: 'docx', token: 'new_created', url: 'https://feishu/new-created', created_time: '200' }
          ]
        }
      }
    },
    { body: { code: 0, data: { items: [{ block_id: 'new_created', children: [] }] } } },
    { body: { code: 0, data: { children: [] } } }
  ]);

  const result = await publishFeishuDoc('Digest body', baseConfig, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.url, 'https://feishu/new-created');
  assert.equal(result.documentId, 'new_created');
});

test('publishFeishuDoc follows folder pagination before creating', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    {
      body: {
        code: 0,
        data: {
          files: [{ name: 'Other', type: 'docx', token: 'other', url: 'https://feishu/other' }],
          has_more: true,
          next_page_token: 'page_2'
        }
      }
    },
    {
      body: {
        code: 0,
        data: {
          items: [
            { name: 'AI Builders Digest - 2026-05-28', type: 'docx', token: 'doc_2', url: 'https://feishu/doc_2' }
          ],
          has_more: false
        }
      }
    },
    { body: { code: 0, data: { items: [{ block_id: 'doc_2', children: [] }] } } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);

  const result = await publishFeishuDoc('Digest body', baseConfig, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.url, 'https://feishu/doc_2');
  assert.match(calls[1].url, /page_size=200/);
  assert.match(calls[2].url, /page_token=page_2/);
  assert.equal(calls.some(call => call.url === 'https://open.feishu.cn/open-apis/docx/v1/documents'), false);
});

test('publishFeishuDoc writes structured blocks in batches', async () => {
  const calls = [];
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    { body: { code: 0, data: { files: [] } } },
    { body: { code: 0, data: { document: { document_id: 'doc_many', url: 'https://feishu/doc_many' } } } },
    { body: { code: 0, data: { items: [{ block_id: 'doc_many', children: [] }] } } },
    { body: { code: 0, data: { children: [] } } },
    { body: { code: 0, data: { children: [] } } }
  ], calls);
  const digest = Array.from({ length: 45 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n');

  const result = await publishFeishuDoc(digest, baseConfig, {
    env: { FEISHU_APP_SECRET: 'secret' },
    fetch,
    now: new Date('2026-05-27T16:30:00.000Z')
  });

  assert.equal(result.fallback, undefined);
  const writeCalls = calls.filter(call => call.url.includes('/children') && call.options.method === 'POST');
  assert.equal(writeCalls.length, 2);
  assert.equal(JSON.parse(writeCalls[0].options.body).children.length, 40);
  assert.equal(JSON.parse(writeCalls[1].options.body).children.length, 5);
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
  assert.equal(result.method, 'feishu_doc');
  assert.match(result.warnings[0], /Structured write failed/);
  const fallbackBody = JSON.parse(calls[5].options.body);
  assert.equal(fallbackBody.children[0].block_type, 2);
  assert.equal(fallbackBody.children[0].text.elements[0].text_run.content, '# Digest');
});

test('publishFeishuDoc rejects token responses without tenant_access_token', async () => {
  const fetch = createMockFetch([
    { body: { code: 0, expire: 7200 } }
  ]);

  await assert.rejects(
    () => publishFeishuDoc('Digest', baseConfig, {
      env: { FEISHU_APP_SECRET: 'secret' },
      fetch,
      now: new Date('2026-05-27T16:30:00.000Z')
    }),
    /missing tenant_access_token/
  );
});

test('publishFeishuDoc rejects created documents without document_id', async () => {
  const fetch = createMockFetch([
    { body: { code: 0, tenant_access_token: 'tenant_token', expire: 7200 } },
    { body: { code: 0, data: { files: [] } } },
    { body: { code: 0, data: { document: { url: 'https://feishu/doc_missing' } } } }
  ]);

  await assert.rejects(
    () => publishFeishuDoc('Digest', baseConfig, {
      env: { FEISHU_APP_SECRET: 'secret' },
      fetch,
      now: new Date('2026-05-27T16:30:00.000Z')
    }),
    /missing document.document_id/
  );
});

test('publishFeishuDoc reports invalid JSON responses with request context', async () => {
  const fetch = createMockFetch([
    { ok: false, status: 502, jsonError: 'Unexpected token <' }
  ]);

  await assert.rejects(
    () => publishFeishuDoc('Digest', baseConfig, {
      env: { FEISHU_APP_SECRET: 'secret' },
      fetch,
      now: new Date('2026-05-27T16:30:00.000Z')
    }),
    /Feishu API invalid JSON POST \/auth\/v3\/tenant_access_token\/internal: HTTP 502/
  );
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
