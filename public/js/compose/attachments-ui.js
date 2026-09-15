export function pickPastedImage(clipboardData) {
  const items = clipboardData?.items;
  if (!items) return null;
  return [...items].find(item => String(item.type || '').startsWith('image/')) || null;
}

export function attachmentPreview(file) {
  const name = String(file?.name || 'file');
  const mime = String(file?.mimeType || '');
  if (mime.startsWith('image/') && file?.data) {
    return { kind: 'image', name, src: `data:${mime};base64,${file.data}` };
  }
  return { kind: 'file', name, src: '' };
}
