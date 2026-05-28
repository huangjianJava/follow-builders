# Feishu Doc Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `follow-builders` 增加 `feishu_doc` 投递方式，让 Codex 手动运行和定时运行都能把每日 digest 幂等写入指定飞书文件夹中的一篇新版文档。

**Architecture:** 保持现有 `prepare-digest.js -> LLM remix -> deliver.js` 链路不变，只在 `deliver.js` 增加新的投递分支。飞书 API、Markdown 转块、日期标题模板各自放到 `scripts/lib/` 的小模块里，便于测试和后续拆成 publisher 架构。

**Tech Stack:** Node.js ESM、内置 `node:test`、`assert/strict`、现有 `dotenv`、全局 `fetch`、飞书开放平台 Docx/Drive/Auth OpenAPI。

---

## 参考接口

实施时只使用飞书官方 OpenAPI：

- 获取自建应用 `tenant_access_token`：`POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- 获取文件夹清单：`GET https://open.feishu.cn/open-apis/drive/v1/files?folder_token=<token>`
- 创建新版文档：`POST https://open.feishu.cn/open-apis/docx/v1/documents`
- 获取文档所有块：`GET https://open.feishu.cn/open-apis/docx/v1/documents/:document_id/blocks`
- 创建块：`POST https://open.feishu.cn/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children`
- 删除子块：`DELETE https://open.feishu.cn/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children/batch_delete`

---

## 文件结构

- Modify: `scripts/package.json`
  - 增加 `test` 脚本，使用 Node 内置测试框架。
- Create: `scripts/lib/date-template.js`
  - 负责按时区生成 `YYYY-MM-DD`、展开标题模板、生成元信息时间戳。
- Create: `scripts/lib/markdown-to-feishu-blocks.js`
  - 把 digest Markdown 转为内部 block 模型，再转成飞书 docx block payload。
- Create: `scripts/lib/feishu-docs.js`
  - 负责配置校验、取 token、列文件夹、创建/更新文档、清空正文、写入块、纯文本 fallback。
- Modify: `scripts/deliver.js`
  - 新增 `feishu_doc` delivery method，调用 `publishFeishuDoc`。
- Modify: `config/config-schema.json`
  - 加入 `feishu_doc` 和 `delivery.feishu` 配置 schema。
- Modify: `SKILL.md`
  - 增加飞书文档投递配置、运行和错误处理说明。
- Modify: `README.md`
  - 增加 Feishu document delivery 说明。
- Modify: `README.zh-CN.md`
  - 增加飞书文档投递说明。
- Create: `scripts/test/date-template.test.js`
  - 覆盖日期、时区、标题模板。
- Create: `scripts/test/markdown-to-feishu-blocks.test.js`
  - 覆盖 digest Markdown 到 block 的转换。
- Create: `scripts/test/feishu-docs.test.js`
  - 用 mock fetch 覆盖飞书 client 行为。
- Create: `scripts/test/deliver-feishu.test.js`
  - 覆盖 `deliver.js` 分发到 `feishu_doc` 的行为。

---

### Task 1: 启用 Node 测试入口

**Files:**
- Modify: `scripts/package.json`

- [ ] **Step 1: 修改测试脚本**

在 `scripts/package.json` 的 `scripts` 字段中加入 `test`，保留现有脚本：

```json
{
  "scripts": {
    "generate-feed": "node generate-feed.js",
    "prepare-digest": "node prepare-digest.js",
    "test": "node --test"
  }
}
```

- [ ] **Step 2: 运行空测试，确认测试框架可用**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
TAP version 13
# tests 0
# pass 0
# fail 0
```

- [ ] **Step 3: 提交**

```bash
git add scripts/package.json
git commit -m "test: enable node test runner"
```

---

### Task 2: 实现日期与标题模板模块

**Files:**
- Create: `scripts/lib/date-template.js`
- Create: `scripts/test/date-template.test.js`

- [ ] **Step 1: 写失败测试**

Create `scripts/test/date-template.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDateInTimezone,
  expandTitleTemplate,
  formatGeneratedAt
} from '../lib/date-template.js';

test('formatDateInTimezone returns YYYY-MM-DD in the requested timezone', () => {
  const date = new Date('2026-05-27T16:30:00.000Z');
  assert.equal(formatDateInTimezone(date, 'Asia/Shanghai'), '2026-05-28');
});

test('expandTitleTemplate replaces {{date}}', () => {
  const date = new Date('2026-05-27T16:30:00.000Z');
  assert.equal(
    expandTitleTemplate('AI Builders Digest - {{date}}', date, 'Asia/Shanghai'),
    'AI Builders Digest - 2026-05-28'
  );
});

test('expandTitleTemplate uses default title when template is empty', () => {
  const date = new Date('2026-05-27T16:30:00.000Z');
  assert.equal(
    expandTitleTemplate('', date, 'Asia/Shanghai'),
    'AI Builders Digest - 2026-05-28'
  );
});

test('formatGeneratedAt includes date, time, and timezone', () => {
  const date = new Date('2026-05-27T16:30:00.000Z');
  assert.equal(
    formatGeneratedAt(date, 'Asia/Shanghai'),
    '2026-05-28 00:30 Asia/Shanghai'
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd scripts && npm test -- test/date-template.test.js
```

Expected:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
```

- [ ] **Step 3: 实现最小模块**

Create `scripts/lib/date-template.js`:

```js
const DEFAULT_TITLE_TEMPLATE = 'AI Builders Digest - {{date}}';

export function formatDateInTimezone(date = new Date(), timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatGeneratedAt(date = new Date(), timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${tz}`;
}

export function expandTitleTemplate(template, date = new Date(), timezone) {
  const effectiveTemplate = template && template.trim()
    ? template
    : DEFAULT_TITLE_TEMPLATE;
  return effectiveTemplate.replaceAll('{{date}}', formatDateInTimezone(date, timezone));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd scripts && npm test -- test/date-template.test.js
```

Expected:

```text
# pass 4
# fail 0
```

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/date-template.js scripts/test/date-template.test.js
git commit -m "feat: add digest title date helpers"
```

---

### Task 3: 实现 Markdown 到内部块模型转换

**Files:**
- Create: `scripts/lib/markdown-to-feishu-blocks.js`
- Create: `scripts/test/markdown-to-feishu-blocks.test.js`

- [ ] **Step 1: 写失败测试**

Create `scripts/test/markdown-to-feishu-blocks.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToDigestBlocks,
  digestBlocksToPlainText
} from '../lib/markdown-to-feishu-blocks.js';

test('markdownToDigestBlocks maps headings paragraphs lists urls and dividers', () => {
  const markdown = [
    '# AI Builders Digest',
    '',
    'Generated summary paragraph.',
    '',
    '- First bullet',
    '* Second bullet',
    '1. First ordered',
    '',
    'https://example.com/item',
    '',
    '---',
    '',
    'Read [the post](https://example.com/post).'
  ].join('\n');

  assert.deepEqual(markdownToDigestBlocks(markdown), [
    { type: 'heading', level: 1, text: 'AI Builders Digest' },
    { type: 'paragraph', text: 'Generated summary paragraph.' },
    { type: 'bullet', text: 'First bullet' },
    { type: 'bullet', text: 'Second bullet' },
    { type: 'ordered', text: 'First ordered' },
    { type: 'paragraph', text: 'https://example.com/item', link: 'https://example.com/item' },
    { type: 'divider' },
    {
      type: 'paragraph',
      text: 'Read the post.',
      marks: [{ start: 5, end: 13, url: 'https://example.com/post' }]
    }
  ]);
});

test('markdownToDigestBlocks treats unsupported code fences as plain text', () => {
  const markdown = ['```js', 'console.log("hello")', '```'].join('\n');
  assert.deepEqual(markdownToDigestBlocks(markdown), [
    { type: 'paragraph', text: '```js' },
    { type: 'paragraph', text: 'console.log("hello")' },
    { type: 'paragraph', text: '```' }
  ]);
});

test('digestBlocksToPlainText preserves readable content', () => {
  const blocks = [
    { type: 'heading', level: 1, text: 'Title' },
    { type: 'bullet', text: 'Point' },
    { type: 'divider' },
    { type: 'paragraph', text: 'Tail' }
  ];

  assert.equal(digestBlocksToPlainText(blocks), '# Title\n\n- Point\n\n---\n\nTail');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd scripts && npm test -- test/markdown-to-feishu-blocks.test.js
```

Expected:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
```

- [ ] **Step 3: 实现内部块转换**

Create `scripts/lib/markdown-to-feishu-blocks.js`:

```js
const URL_RE = /^https?:\/\/\S+$/;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

export function markdownToDigestBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1].trim() });
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      blocks.push({ type: 'ordered', text: ordered[1].trim() });
      continue;
    }

    if (/^-{3,}$/.test(line)) {
      blocks.push({ type: 'divider' });
      continue;
    }

    if (URL_RE.test(line)) {
      blocks.push({ type: 'paragraph', text: line, link: line });
      continue;
    }

    blocks.push(parseParagraph(line));
  }

  return blocks;
}

function parseParagraph(line) {
  const marks = [];
  let text = '';
  let lastIndex = 0;
  let match;

  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_LINK_RE.exec(line)) !== null) {
    text += line.slice(lastIndex, match.index);
    const start = text.length;
    text += match[1];
    marks.push({ start, end: text.length, url: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (marks.length === 0) return { type: 'paragraph', text: line };

  text += line.slice(lastIndex);
  return { type: 'paragraph', text, marks };
}

export function digestBlocksToPlainText(blocks) {
  return blocks.map(block => {
    if (block.type === 'heading') return `${'#'.repeat(block.level)} ${block.text}`;
    if (block.type === 'bullet') return `- ${block.text}`;
    if (block.type === 'ordered') return `1. ${block.text}`;
    if (block.type === 'divider') return '---';
    return block.text || '';
  }).join('\n\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd scripts && npm test -- test/markdown-to-feishu-blocks.test.js
```

Expected:

```text
# pass 3
# fail 0
```

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/markdown-to-feishu-blocks.js scripts/test/markdown-to-feishu-blocks.test.js
git commit -m "feat: parse digest markdown blocks"
```

---

### Task 4: 实现飞书块 payload 映射

**Files:**
- Modify: `scripts/lib/markdown-to-feishu-blocks.js`
- Modify: `scripts/test/markdown-to-feishu-blocks.test.js`

- [ ] **Step 1: 写失败测试**

Append to `scripts/test/markdown-to-feishu-blocks.test.js`:

```js
import { digestBlocksToFeishuBlocks } from '../lib/markdown-to-feishu-blocks.js';

test('digestBlocksToFeishuBlocks maps digest blocks to Feishu block payloads', () => {
  const blocks = [
    { type: 'heading', level: 2, text: 'Tweets' },
    { type: 'paragraph', text: 'Read post', marks: [{ start: 5, end: 9, url: 'https://example.com' }] },
    { type: 'bullet', text: 'One point' },
    { type: 'ordered', text: 'First point' },
    { type: 'divider' }
  ];

  assert.deepEqual(digestBlocksToFeishuBlocks(blocks), [
    {
      block_type: 4,
      heading2: { elements: [{ text_run: { content: 'Tweets' } }] }
    },
    {
      block_type: 2,
      text: {
        elements: [
          { text_run: { content: 'Read ' } },
          { text_run: { content: 'post', text_element_style: { link: { url: 'https://example.com' } } } }
        ]
      }
    },
    {
      block_type: 12,
      bullet: { elements: [{ text_run: { content: 'One point' } }] }
    },
    {
      block_type: 13,
      ordered: { elements: [{ text_run: { content: 'First point' } }] }
    },
    {
      block_type: 22,
      divider: {}
    }
  ]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd scripts && npm test -- test/markdown-to-feishu-blocks.test.js
```

Expected:

```text
SyntaxError: The requested module '../lib/markdown-to-feishu-blocks.js' does not provide an export named 'digestBlocksToFeishuBlocks'
```

- [ ] **Step 3: 实现飞书 payload 映射**

Append to `scripts/lib/markdown-to-feishu-blocks.js`:

```js
export function digestBlocksToFeishuBlocks(blocks) {
  return blocks.map(block => {
    if (block.type === 'heading') {
      const level = Math.min(Math.max(block.level || 1, 1), 3);
      const key = `heading${level}`;
      return {
        block_type: level === 1 ? 3 : level === 2 ? 4 : 5,
        [key]: { elements: textElements(block.text || '', block.marks || []) }
      };
    }

    if (block.type === 'bullet') {
      return {
        block_type: 12,
        bullet: { elements: textElements(block.text || '', block.marks || []) }
      };
    }

    if (block.type === 'ordered') {
      return {
        block_type: 13,
        ordered: { elements: textElements(block.text || '', block.marks || []) }
      };
    }

    if (block.type === 'divider') {
      return { block_type: 22, divider: {} };
    }

    const marks = block.link
      ? [{ start: 0, end: block.text.length, url: block.link }]
      : block.marks || [];

    return {
      block_type: 2,
      text: { elements: textElements(block.text || '', marks) }
    };
  });
}

function textElements(text, marks) {
  if (!marks || marks.length === 0) {
    return [{ text_run: { content: text } }];
  }

  const elements = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) {
      elements.push({ text_run: { content: text.slice(cursor, mark.start) } });
    }
    elements.push({
      text_run: {
        content: text.slice(mark.start, mark.end),
        text_element_style: { link: { url: mark.url } }
      }
    });
    cursor = mark.end;
  }

  if (cursor < text.length) {
    elements.push({ text_run: { content: text.slice(cursor) } });
  }

  return elements;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd scripts && npm test -- test/markdown-to-feishu-blocks.test.js
```

Expected:

```text
# pass 4
# fail 0
```

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/markdown-to-feishu-blocks.js scripts/test/markdown-to-feishu-blocks.test.js
git commit -m "feat: map digest blocks to feishu payloads"
```

---

### Task 5: 实现飞书 client 与发布流程

**Files:**
- Create: `scripts/lib/feishu-docs.js`
- Create: `scripts/test/feishu-docs.test.js`

- [ ] **Step 1: 写失败测试**

Create `scripts/test/feishu-docs.test.js`:

```js
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd scripts && npm test -- test/feishu-docs.test.js
```

Expected:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
```

- [ ] **Step 3: 实现飞书发布模块**

Create `scripts/lib/feishu-docs.js`:

```js
import {
  digestBlocksToFeishuBlocks,
  digestBlocksToPlainText,
  markdownToDigestBlocks
} from './markdown-to-feishu-blocks.js';
import { expandTitleTemplate, formatGeneratedAt } from './date-template.js';

const BASE_URL = 'https://open.feishu.cn/open-apis';

export function validateFeishuConfig(config, env = process.env) {
  const feishu = config?.delivery?.feishu || {};
  const appSecretEnv = feishu.appSecretEnv || 'FEISHU_APP_SECRET';
  const appSecret = env[appSecretEnv];

  if (!feishu.appId) throw new Error('delivery.feishu.appId is required');
  if (!appSecret) throw new Error(`${appSecretEnv} is required in ~/.follow-builders/.env`);
  if (!feishu.folderToken) throw new Error('delivery.feishu.folderToken is required');
  if (feishu.onExisting && feishu.onExisting !== 'update') {
    throw new Error('delivery.feishu.onExisting must be "update"');
  }

  return {
    appId: feishu.appId,
    appSecret,
    folderToken: feishu.folderToken,
    titleTemplate: feishu.titleTemplate || 'AI Builders Digest - {{date}}',
    timezone: feishu.timezone || config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    includeMetadata: feishu.includeMetadata !== false
  };
}

export async function publishFeishuDoc(digestText, config, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const env = options.env || process.env;
  const now = options.now || new Date();
  const settings = validateFeishuConfig(config, env);
  const token = await getTenantAccessToken(settings, fetchImpl);
  const title = expandTitleTemplate(settings.titleTemplate, now, settings.timezone);
  const matches = await findDocumentsByTitle(settings.folderToken, title, token, fetchImpl);
  const warnings = [];

  if (matches.length > 1) {
    warnings.push(`Multiple documents found for title "${title}"; updated the newest match.`);
  }

  let action = 'updated';
  let document = pickNewestDocument(matches);
  if (!document) {
    action = 'created';
    document = await createDocument(settings.folderToken, title, token, fetchImpl);
  }

  const markdown = settings.includeMetadata
    ? `Generated at: ${formatGeneratedAt(now, settings.timezone)}\nSource: follow-builders\n\n${digestText}`
    : digestText;

  const digestBlocks = markdownToDigestBlocks(markdown);
  const feishuBlocks = digestBlocksToFeishuBlocks(digestBlocks);

  try {
    await replaceDocumentBody(document.documentId, feishuBlocks, token, fetchImpl);
  } catch (err) {
    warnings.push(`Structured block write failed: ${err.message}; used plain text fallback.`);
    await replaceDocumentBody(document.documentId, digestBlocksToFeishuBlocks([
      { type: 'paragraph', text: digestBlocksToPlainText(digestBlocks) }
    ]), token, fetchImpl);
    return {
      status: 'ok',
      method: 'feishu_doc',
      action,
      title,
      url: document.url,
      fallback: 'plain_text',
      warnings
    };
  }

  return {
    status: 'ok',
    method: 'feishu_doc',
    action,
    title,
    url: document.url,
    warnings: warnings.length ? warnings : undefined
  };
}

async function getTenantAccessToken(settings, fetchImpl) {
  const data = await feishuRequest(fetchImpl, '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: {
      app_id: settings.appId,
      app_secret: settings.appSecret
    }
  }, null);
  return data.tenant_access_token;
}

async function findDocumentsByTitle(folderToken, title, token, fetchImpl) {
  const params = new URLSearchParams({ folder_token: folderToken, page_size: '50' });
  const data = await feishuRequest(fetchImpl, `/drive/v1/files?${params}`, { method: 'GET' }, token);
  const files = data.files || data.items || [];
  return files
    .filter(file => file.name === title && (file.type === 'docx' || file.type === 'doc'))
    .map(file => ({
      documentId: file.token,
      title: file.name,
      url: file.url,
      modifiedTime: Number(file.modified_time || file.created_time || 0)
    }));
}

function pickNewestDocument(documents) {
  return [...documents].sort((a, b) => b.modifiedTime - a.modifiedTime)[0] || null;
}

async function createDocument(folderToken, title, token, fetchImpl) {
  const data = await feishuRequest(fetchImpl, '/docx/v1/documents', {
    method: 'POST',
    body: {
      folder_token: folderToken,
      title
    }
  }, token);
  const doc = data.document || data;
  return {
    documentId: doc.document_id || doc.documentId,
    title,
    url: doc.url
  };
}

async function replaceDocumentBody(documentId, blocks, token, fetchImpl) {
  const rootBlockId = await getRootBlockId(documentId, token, fetchImpl);
  await deleteRootChildren(documentId, rootBlockId, token, fetchImpl);
  if (blocks.length > 0) {
    await createChildren(documentId, rootBlockId, blocks, token, fetchImpl);
  }
}

async function getRootBlockId(documentId, token, fetchImpl) {
  const data = await feishuRequest(fetchImpl, `/docx/v1/documents/${documentId}/blocks`, {
    method: 'GET'
  }, token);
  const blocks = data.items || [];
  return blocks[0]?.block_id || documentId;
}

async function deleteRootChildren(documentId, rootBlockId, token, fetchImpl) {
  await feishuRequest(fetchImpl, `/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children/batch_delete`, {
    method: 'DELETE',
    body: {
      start_index: 0,
      end_index: 500
    }
  }, token);
}

async function createChildren(documentId, parentBlockId, children, token, fetchImpl) {
  await feishuRequest(fetchImpl, `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`, {
    method: 'POST',
    body: { children }
  }, token);
}

async function feishuRequest(fetchImpl, path, options, token) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();

  if (!response.ok || payload.code !== 0) {
    throw new Error(`Feishu API error ${payload.code ?? response.status}: ${payload.msg || JSON.stringify(payload)}`);
  }

  return payload.data || payload;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd scripts && npm test -- test/feishu-docs.test.js
```

Expected:

```text
# pass 3
# fail 0
```

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/feishu-docs.js scripts/test/feishu-docs.test.js
git commit -m "feat: publish digest to feishu docs"
```

---

### Task 6: 接入 deliver.js

**Files:**
- Modify: `scripts/deliver.js`
- Create: `scripts/test/deliver-feishu.test.js`

- [ ] **Step 1: 为可测试性导出主流程**

Modify `scripts/deliver.js`：

```js
import { publishFeishuDoc } from './lib/feishu-docs.js';
```

将现有 `main()` 改成可注入依赖。`configOverride` 和 `publishFeishuDocImpl` 只用于测试；正常命令行运行仍读取 `~/.follow-builders/config.json` 并调用真实飞书发布模块：

```js
export async function deliverDigest({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  env = process.env,
  fetchImpl = fetch,
  configOverride,
  publishFeishuDocImpl = publishFeishuDoc
} = {}) {
  loadEnv({ path: ENV_PATH });

  let config = configOverride || {};
  if (!configOverride && existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText(argv, stdin);

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  switch (delivery.method) {
    case 'telegram':
      return sendConfiguredTelegram(digestText, delivery, env);
    case 'email':
      return sendConfiguredEmail(digestText, delivery, env);
    case 'feishu_doc': {
      const result = await publishFeishuDocImpl(digestText, config, { env, fetch: fetchImpl });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    case 'stdout':
    default:
      console.log(digestText);
      return { status: 'ok', method: 'stdout' };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  deliverDigest().catch(err => {
    console.log(JSON.stringify({
      status: 'error',
      message: err.message
    }));
    process.exit(1);
  });
}
```

同时把 `getDigestText` 签名改为：

```js
async function getDigestText(args = process.argv.slice(2), stdin = process.stdin) {
```

并把函数内部的 `process.argv.slice(2)` 替换为入参 `args`，把 `process.stdin` 替换为入参 `stdin`。

- [ ] **Step 2: 整理 Telegram/Email 分支**

在 `scripts/deliver.js` 中把原 switch 里的 Telegram 和 Email 逻辑分别提取为：

```js
async function sendConfiguredTelegram(digestText, delivery, env = process.env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = delivery.chatId;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
  if (!chatId) throw new Error('delivery.chatId not found in config.json');
  await sendTelegram(digestText, botToken, chatId);
  console.log(JSON.stringify({
    status: 'ok',
    method: 'telegram',
    message: 'Digest sent to Telegram'
  }));
}

async function sendConfiguredEmail(digestText, delivery, env = process.env) {
  const apiKey = env.RESEND_API_KEY;
  const toEmail = delivery.email;
  if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
  if (!toEmail) throw new Error('delivery.email not found in config.json');
  await sendEmail(digestText, apiKey, toEmail);
  console.log(JSON.stringify({
    status: 'ok',
    method: 'email',
    message: `Digest sent to ${toEmail}`
  }));
}
```

- [ ] **Step 3: 写 deliver 分发测试**

Create `scripts/test/deliver-feishu.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { deliverDigest } from '../deliver.js';

test('deliverDigest routes feishu_doc delivery to Feishu publisher', async () => {
  const stdin = Readable.from(['# Digest']);
  const logs = [];
  const originalLog = console.log;
  console.log = value => logs.push(value);

  try {
    const result = await deliverDigest({
      argv: [],
      stdin,
      configOverride: {
        delivery: {
          method: 'feishu_doc',
          feishu: {
            appId: 'cli_test',
            folderToken: 'fld_test'
          }
        }
      },
      env: { FEISHU_APP_SECRET: 'secret' },
      publishFeishuDocImpl: async (digestText, config, options) => {
        assert.equal(digestText, '# Digest');
        assert.equal(config.delivery.method, 'feishu_doc');
        assert.equal(options.env.FEISHU_APP_SECRET, 'secret');
        return {
          status: 'ok',
          method: 'feishu_doc',
          action: 'created',
          title: 'AI Builders Digest - 2026-05-28',
          url: 'https://feishu.example/doc'
        };
      }
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.method, 'feishu_doc');
    assert.match(logs[0], /feishu_doc/);
  } finally {
    console.log = originalLog;
  }
});
```

- [ ] **Step 4: 运行 deliver 相关测试**

Run:

```bash
cd scripts && npm test -- test/deliver-feishu.test.js test/feishu-docs.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: 提交**

```bash
git add scripts/deliver.js scripts/test/deliver-feishu.test.js
git commit -m "feat: route feishu doc delivery"
```

---

### Task 7: 更新配置 schema

**Files:**
- Modify: `config/config-schema.json`

- [ ] **Step 1: 修改 `delivery.method` enum**

把：

```json
"enum": ["stdout", "telegram", "email"]
```

改成：

```json
"enum": ["stdout", "telegram", "email", "feishu_doc"]
```

- [ ] **Step 2: 在 `delivery.properties` 下加入 `feishu`**

加入：

```json
"feishu": {
  "type": "object",
  "description": "Feishu document delivery configuration (only for feishu_doc method)",
  "properties": {
    "appId": {
      "type": "string",
      "description": "Feishu self-built app ID"
    },
    "appSecretEnv": {
      "type": "string",
      "default": "FEISHU_APP_SECRET",
      "description": "Environment variable name containing the Feishu app secret"
    },
    "folderToken": {
      "type": "string",
      "description": "Target Feishu cloud-docs folder token"
    },
    "titleTemplate": {
      "type": "string",
      "default": "AI Builders Digest - {{date}}",
      "description": "Daily document title template. {{date}} expands to YYYY-MM-DD"
    },
    "timezone": {
      "type": "string",
      "default": "Asia/Shanghai",
      "description": "Timezone used to calculate the daily document date"
    },
    "onExisting": {
      "type": "string",
      "enum": ["update"],
      "default": "update",
      "description": "How to handle an existing document with today's title"
    },
    "includeMetadata": {
      "type": "boolean",
      "default": true,
      "description": "Whether to prepend generated-at metadata to the document"
    }
  }
}
```

- [ ] **Step 3: 校验 JSON 有效**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('config/config-schema.json','utf8')); console.log('ok')"
```

Expected:

```text
ok
```

- [ ] **Step 4: 提交**

```bash
git add config/config-schema.json
git commit -m "docs: add feishu delivery config schema"
```

---

### Task 8: 更新 skill 与 README 文档

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: 更新 `SKILL.md` Delivery Method**

在现有 Telegram/Email/stdout 描述附近加入 Feishu 文档投递说明：

```markdown
**Feishu Document** — Writes each digest into a Feishu cloud-docs folder as one document per day. This requires a Feishu self-built app with document and drive permissions.

Config:

```json
{
  "delivery": {
    "method": "feishu_doc",
    "feishu": {
      "appId": "cli_xxx",
      "appSecretEnv": "FEISHU_APP_SECRET",
      "folderToken": "fldcn_xxx",
      "titleTemplate": "AI Builders Digest - {{date}}",
      "timezone": "Asia/Shanghai",
      "onExisting": "update",
      "includeMetadata": true
    }
  }
}
```

`.env`:

```bash
FEISHU_APP_SECRET=...
```

When `feishu_doc` is selected, the agent still remixes the digest first, then passes the final Markdown to `deliver.js`. Same-day reruns update the existing document with the same generated title.
```

- [ ] **Step 2: 更新 `SKILL.md` Content Delivery Step 6**

在 delivery switch 说明中加入：

```markdown
**If "feishu_doc":**
```bash
echo '<your digest text>' > /tmp/fb-digest.txt
cd ${CLAUDE_SKILL_DIR}/scripts && node deliver.js --file /tmp/fb-digest.txt 2>/dev/null
```

If delivery succeeds, show the returned document URL. If it fails, show the JSON error and the digest text as fallback.
```

- [ ] **Step 3: 更新英文 README**

在 delivery methods 说明中加入：

```markdown
- Feishu Docs: create or update one Feishu document per day in a configured cloud-docs folder. Requires a Feishu self-built app and folder token.
```

在隐私或配置章节加入：

```markdown
For Feishu Docs delivery, store `FEISHU_APP_SECRET` locally in `~/.follow-builders/.env`. The app ID and folder token live in `~/.follow-builders/config.json`.
```

- [ ] **Step 4: 更新中文 README**

在推送方式说明中加入：

```markdown
- 飞书文档：每天在指定飞书云文档文件夹中创建或更新一篇日报文档。需要飞书自建应用和目标文件夹 token。
```

在隐私或配置章节加入：

```markdown
如果使用飞书文档投递，`FEISHU_APP_SECRET` 只保存在本地 `~/.follow-builders/.env`；App ID 和文件夹 token 保存在 `~/.follow-builders/config.json`。
```

- [ ] **Step 5: 检查文档中没有错误占位**

Run:

```bash
rg -n "TBD|TODO|paste_your|xxx" SKILL.md README.md README.zh-CN.md
```

Expected:

```text
```

如果命中示例里的 `cli_xxx` 或 `fldcn_xxx`，确认它们只出现在明确标注为示例的配置块中，不作为待办处理。

- [ ] **Step 6: 提交**

```bash
git add SKILL.md README.md README.zh-CN.md
git commit -m "docs: document feishu doc delivery"
```

---

### Task 9: 全量验证与手动飞书验证

**Files:**
- No code changes expected unless verification finds a bug.

- [ ] **Step 1: 运行全部自动测试**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# fail 0
```

- [ ] **Step 2: 运行现有 prepare digest 脚本**

Run:

```bash
cd scripts && node prepare-digest.js >/tmp/follow-builders-prepare.json
```

Expected:

```text
```

Then:

```bash
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/follow-builders-prepare.json','utf8')); console.log(data.status, data.stats && typeof data.stats.totalTweets === 'number')"
```

Expected:

```text
ok true
```

- [ ] **Step 3: 本地 stdout delivery 回归**

Run:

```bash
printf '# Test Digest\n\nHello' | cd scripts && node deliver.js
```

Expected:

```text
# Test Digest

Hello
```

- [ ] **Step 4: 飞书手动验证前准备**

在 `~/.follow-builders/config.json` 中设置：

```json
{
  "language": "zh",
  "timezone": "Asia/Shanghai",
  "frequency": "daily",
  "delivery": {
    "method": "feishu_doc",
    "feishu": {
      "appId": "cli_real_app_id",
      "appSecretEnv": "FEISHU_APP_SECRET",
      "folderToken": "real_folder_token",
      "titleTemplate": "AI Builders Digest - {{date}}",
      "timezone": "Asia/Shanghai",
      "onExisting": "update",
      "includeMetadata": true
    }
  },
  "onboardingComplete": true
}
```

在 `~/.follow-builders/.env` 中设置：

```bash
FEISHU_APP_SECRET=real_app_secret
```

- [ ] **Step 5: 执行飞书创建验证**

Run:

```bash
printf '# AI Builders Digest\n\n- Test item\n\nhttps://example.com' >/tmp/fb-digest.txt
cd scripts && node deliver.js --file /tmp/fb-digest.txt
```

Expected:

```json
{
  "status": "ok",
  "method": "feishu_doc",
  "action": "created",
  "title": "AI Builders Digest - 2026-05-28",
  "url": "https://..."
}
```

- [ ] **Step 6: 执行飞书幂等更新验证**

Run:

```bash
printf '# AI Builders Digest\n\n- Updated item\n\nhttps://example.com/updated' >/tmp/fb-digest.txt
cd scripts && node deliver.js --file /tmp/fb-digest.txt
```

Expected:

```json
{
  "status": "ok",
  "method": "feishu_doc",
  "action": "updated",
  "title": "AI Builders Digest - 2026-05-28",
  "url": "https://..."
}
```

同时在飞书文件夹中确认没有新增第二篇同标题文档，原文档内容变为 `Updated item`。

- [ ] **Step 7: 提交最终验证修复**

如果 Task 9 发现并修复了代码或文档问题：

```bash
git add scripts config SKILL.md README.md README.zh-CN.md
git commit -m "fix: verify feishu doc delivery"
```

如果没有改动，不提交。

---

## 实施注意事项

- 不要在仓库中提交真实 `app_id`、`app_secret`、`folderToken`。
- `tenant_access_token` 有过期时间，但第一版每次投递重新获取即可，避免引入缓存复杂度。
- 如果飞书 block type 常量与实际 API 校验不一致，优先以官方 API 调试台返回为准修正 `digestBlocksToFeishuBlocks`，并同步更新测试。
- 如果 `children/batch_delete` 对 `end_index` 约束更严格，改为先读取 root children 数量，再传精确范围，并补充测试。
- 如果个人空间文件夹对 `tenant_access_token` 无权限，给用户返回清晰错误，让用户把文件夹授权给自建应用或改用应用可访问的文件夹。
- 不改 feed 抓取、不改 prompts、不引入数据库、不做 OAuth。

## 自审记录

- Spec coverage: 覆盖了 `feishu_doc` delivery、配置、幂等每日文档、Markdown 块映射、纯文本 fallback、错误处理、测试和文档更新。
- Placeholder scan: 计划中的 `cli_xxx`、`fldcn_xxx`、`real_*` 都是示例占位，明确用于用户本地配置，不是实现待办。
- Type consistency: 计划统一使用 `publishFeishuDoc`、`validateFeishuConfig`、`markdownToDigestBlocks`、`digestBlocksToFeishuBlocks`、`expandTitleTemplate` 等函数名。
