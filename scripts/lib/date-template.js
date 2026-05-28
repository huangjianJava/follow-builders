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
