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
