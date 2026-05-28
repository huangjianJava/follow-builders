import { expandTitleTemplate, formatGeneratedAt } from './date-template.js';
import {
  digestBlocksToFeishuBlocks,
  digestBlocksToPlainText,
  markdownToDigestBlocks
} from './markdown-to-feishu-blocks.js';

const BASE_URL = 'https://open.feishu.cn/open-apis';
const DEFAULT_SECRET_ENV = 'FEISHU_APP_SECRET';

export function validateFeishuConfig(config, env = process.env) {
  const feishu = config?.delivery?.feishu || {};
  const secretEnv = feishu.appSecretEnv || DEFAULT_SECRET_ENV;

  if (!feishu.appId) {
    throw new Error('delivery.feishu.appId is required');
  }

  if (!env?.[secretEnv]) {
    throw new Error(`${secretEnv} is required`);
  }

  if (!feishu.folderToken) {
    throw new Error('delivery.feishu.folderToken is required');
  }

  if (feishu.onExisting && feishu.onExisting !== 'update') {
    throw new Error('delivery.feishu.onExisting must be "update" when provided');
  }

  return {
    ...feishu,
    includeMetadata: feishu.includeMetadata !== false,
    appSecretEnv: secretEnv,
    appSecret: env[secretEnv]
  };
}

export async function publishFeishuDoc(digestText, config, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || new Date();
  const feishu = validateFeishuConfig(config, env);
  const timezone = feishu.timezone || config?.timezone;
  const title = expandTitleTemplate(feishu.titleTemplate, now, timezone);
  const warnings = [];

  if (!fetchImpl) {
    throw new Error('fetch is required');
  }

  const token = await getTenantAccessToken(fetchImpl, feishu);
  const files = await listFolderFiles(fetchImpl, token, feishu.folderToken);
  const existing = findExistingDocument(files, title, warnings);

  let documentId;
  let url;
  let action;

  if (existing && (feishu.onExisting || 'update') === 'update') {
    documentId = existing.token;
    url = existing.url;
    action = 'updated';
  } else {
    const document = await createDocument(fetchImpl, token, feishu.folderToken, title);
    documentId = document.document_id;
    url = document.url;
    action = 'created';
  }

  const content = withMetadata(digestText, feishu.includeMetadata, now, timezone);
  const blocks = markdownToDigestBlocks(content);
  const rootBlock = await getRootBlock(fetchImpl, token, documentId);

  if (rootBlock.childCount > 0) {
    await deleteRootChildren(fetchImpl, token, documentId, rootBlock.blockId, rootBlock.childCount);
  }

  let fallback;
  try {
    await createChildren(fetchImpl, token, documentId, rootBlock.blockId, digestBlocksToFeishuBlocks(blocks));
  } catch (error) {
    fallback = 'plain_text';
    warnings.push(`Structured write failed; fell back to plain text: ${error.message}`);
    await createChildren(fetchImpl, token, documentId, rootBlock.blockId, [
      plainTextParagraph(digestBlocksToPlainText(blocks))
    ]);
  }

  return {
    status: 'ok',
    action,
    title,
    url,
    documentId,
    warnings,
    ...(fallback ? { fallback } : {})
  };
}

async function getTenantAccessToken(fetchImpl, feishu) {
  const payload = await feishuRequest(fetchImpl, '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: {
      app_id: feishu.appId,
      app_secret: feishu.appSecret
    }
  });

  if (!payload.tenant_access_token) {
    throw new Error('Feishu API response missing tenant_access_token');
  }

  return payload.tenant_access_token;
}

async function listFolderFiles(fetchImpl, token, folderToken) {
  const files = [];
  let pageToken;

  do {
    const query = new URLSearchParams({
      folder_token: folderToken,
      page_size: '200'
    });
    if (pageToken) query.set('page_token', pageToken);

    const payload = await feishuRequest(fetchImpl, `/drive/v1/files?${query}`, {
      method: 'GET',
      token
    });
    const data = payload.data || {};
    files.push(...(data.files || data.items || payload.files || payload.items || []));
    pageToken = data.next_page_token || payload.next_page_token;

    if (!(data.has_more ?? payload.has_more)) break;
  } while (pageToken);

  return files;
}

async function createDocument(fetchImpl, token, folderToken, title) {
  const payload = await feishuRequest(fetchImpl, '/docx/v1/documents', {
    method: 'POST',
    token,
    body: {
      folder_token: folderToken,
      title
    }
  });
  const document = payload.data?.document || {};

  if (!document.document_id) {
    throw new Error('Feishu API response missing document.document_id');
  }

  if (!document.url) {
    throw new Error('Feishu API response missing document.url');
  }

  return document;
}

async function getRootBlock(fetchImpl, token, documentId) {
  const payload = await feishuRequest(fetchImpl, `/docx/v1/documents/${documentId}/blocks`, {
    method: 'GET',
    token
  });
  const root = payload.data?.items?.[0] || { block_id: documentId, children: [] };
  return {
    blockId: root.block_id || documentId,
    childCount: root.children?.length || 0
  };
}

async function deleteRootChildren(fetchImpl, token, documentId, rootBlockId, childCount) {
  await feishuRequest(
    fetchImpl,
    `/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children/batch_delete`,
    {
      method: 'DELETE',
      token,
      body: {
        start_index: 0,
        end_index: childCount
      }
    }
  );
}

async function createChildren(fetchImpl, token, documentId, parentBlockId, children) {
  await feishuRequest(
    fetchImpl,
    `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
    {
      method: 'POST',
      token,
      body: { children }
    }
  );
}

async function feishuRequest(fetchImpl, path, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
  };
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `Feishu API invalid JSON ${options.method || 'GET'} ${path}: HTTP ${response.status} ${error.message}`
    );
  }

  if (!response.ok || payload?.code !== 0) {
    const message = payload?.msg || payload?.message || 'unknown error';
    throw new Error(
      `Feishu API error ${options.method || 'GET'} ${path}: HTTP ${response.status} code ${payload?.code} ${message}`
    );
  }

  return payload;
}

function findExistingDocument(files, title, warnings) {
  const matches = files.filter(file => file.name === title && file.type === 'docx');
  if (matches.length === 0) return null;

  if (matches.length > 1) {
    warnings.push(`Multiple documents named "${title}" found; updating newest by modified_time.`);
  }

  const newest = matches.sort((a, b) => Number(b.modified_time || 0) - Number(a.modified_time || 0))[0];

  if (!newest.token) {
    throw new Error(`Feishu folder file "${title}" is missing token`);
  }

  if (!newest.url) {
    throw new Error(`Feishu folder file "${title}" is missing url`);
  }

  return newest;
}

function withMetadata(digestText, includeMetadata, now, timezone) {
  if (!includeMetadata) return String(digestText || '');
  return `Generated at: ${formatGeneratedAt(now, timezone)}\nSource: follow-builders\n\n${digestText || ''}`;
}

function plainTextParagraph(content) {
  return {
    block_type: 2,
    text: {
      elements: [{ text_run: { content } }]
    }
  };
}
