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
