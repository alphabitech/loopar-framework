'use strict';

/**
 * Whether an uploaded file matches a field's `accept` list (".pdf,.docx",
 * "image/*", "application/pdf"). An empty list accepts anything.
 */
export function acceptsFile(accept, file) {
  const rules = String(accept ?? '').split(',').map(r => r.trim().toLowerCase()).filter(r => r && r !== '/*' && r !== '*/*' && r !== '*');
  if (!rules.length) return true;
  const name = String(file?.originalname ?? file?.name ?? '').toLowerCase();
  const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
  const mime = String(file?.mimetype ?? file?.type ?? '').toLowerCase();
  return rules.some(rule => {
    if (rule.startsWith('.')) return ext === rule;
    if (rule.endsWith('/*')) return mime.startsWith(rule.slice(0, -1));
    return mime === rule;
  });
}

