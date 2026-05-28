import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToDigestBlocks,
  digestBlocksToPlainText,
  digestBlocksToFeishuBlocks
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
