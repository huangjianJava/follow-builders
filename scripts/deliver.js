#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: Telegram bot, Email (via Resend), or stdout (default).
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods:
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "feishu_doc": publishes to Feishu Docs
//   - "stdout" (default): just prints to terminal
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { config as loadEnv } from 'dotenv';
import { publishFeishuDoc } from './lib/feishu-docs.js';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText(argv = process.argv.slice(2), stdin = process.stdin) {
  // Check --message flag
  const msgIdx = argv.indexOf('--message');
  if (msgIdx !== -1 && argv[msgIdx + 1]) {
    return argv[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    return await readFile(argv[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId, fetchImpl = fetch) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetchImpl(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

async function sendConfiguredTelegram(text, delivery, env, fetchImpl) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = delivery.chatId;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
  if (!chatId) throw new Error('delivery.chatId not found in config.json');
  await sendTelegram(text, botToken, chatId, fetchImpl);
  const result = {
    status: 'ok',
    method: 'telegram',
    message: 'Digest sent to Telegram'
  };
  console.log(JSON.stringify(result));
  return result;
}

async function sendConfiguredEmail(text, delivery, env, fetchImpl) {
  const apiKey = env.RESEND_API_KEY;
  const toEmail = delivery.email;
  if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
  if (!toEmail) throw new Error('delivery.email not found in config.json');
  await sendEmail(text, apiKey, toEmail, fetchImpl);
  const result = {
    status: 'ok',
    method: 'email',
    message: `Digest sent to ${toEmail}`
  };
  console.log(JSON.stringify(result));
  return result;
}

export function formatDeliveryError(err, method) {
  return {
    status: 'error',
    method,
    message: err.message
  };
}

export function isCliEntrypoint(argvPath, metaUrl) {
  return Boolean(argvPath && metaUrl === pathToFileURL(argvPath).href);
}

// -- Main --------------------------------------------------------------------

export async function deliverDigest({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  env = process.env,
  fetchImpl = fetch,
  configOverride,
  publishFeishuDocImpl = publishFeishuDoc
} = {}) {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = configOverride || {};
  let delivery = config.delivery || { method: 'stdout' };

  try {
    if (!configOverride && existsSync(CONFIG_PATH)) {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
      delivery = config.delivery || { method: 'stdout' };
    }

    const digestText = await getDigestText(argv, stdin);

    if (!digestText || digestText.trim().length === 0) {
      const result = { status: 'skipped', reason: 'Empty digest text' };
      console.log(JSON.stringify(result));
      return result;
    }

    switch (delivery.method) {
      case 'telegram':
        return await sendConfiguredTelegram(digestText, delivery, env, fetchImpl);

      case 'email':
        return await sendConfiguredEmail(digestText, delivery, env, fetchImpl);

      case 'feishu_doc': {
        const result = await publishFeishuDocImpl(digestText, config, {
          env,
          fetch: fetchImpl
        });
        console.log(JSON.stringify(result, null, 2));
        return result;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery
        console.log(digestText);
        return { status: 'ok', method: 'stdout' };
    }
  } catch (err) {
    console.log(JSON.stringify(formatDeliveryError(err, delivery.method || 'unknown')));
    throw err;
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  deliverDigest().catch(err => {
    process.exit(1);
  });
}
