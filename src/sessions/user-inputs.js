export function buildUserInputs({ text, attachments = [], parts = [] } = {}) {
  const inputs = [];
  if (typeof text === 'string' && text.length > 0) {
    inputs.push({
      type: 'text',
      text,
      text_elements: [],
    });
  }
  for (const attachment of attachments) {
    if (attachment?.kind === 'image') {
      if (typeof attachment.absPath !== 'string' || !attachment.absPath) {
        throw new Error('Verified image requires an absolute path');
      }
      inputs.push({ type: 'localImage', path: attachment.absPath });
      continue;
    }
    if (attachment?.kind === 'file') {
      if (
        typeof attachment.name !== 'string'
        || !attachment.name
        || typeof attachment.absPath !== 'string'
        || !attachment.absPath
      ) {
        throw new Error('Uploaded file requires a name and absolute path');
      }
      inputs.push({ type: 'mention', name: attachment.name, path: attachment.absPath });
    }
  }
  for (const part of parts) {
    if (part?.kind === 'imageUrl') {
      if (typeof part.url !== 'string' || !part.url) {
        throw new Error('Image URL requires a URL');
      }
      if (
        part.detail !== undefined
        && !['auto', 'low', 'high', 'original'].includes(part.detail)
      ) {
        throw new Error('Image URL detail is invalid');
      }
      inputs.push({
        type: 'image',
        url: part.url,
        ...(part.detail ? { detail: part.detail } : {}),
      });
      continue;
    }
    if (part?.kind !== 'skill' && part?.kind !== 'mention') continue;
    if (
      typeof part.name !== 'string'
      || !part.name
      || typeof part.path !== 'string'
      || !part.path
    ) {
      throw new Error(`${part.kind === 'skill' ? 'Skill' : 'Mention'} requires a name and path`);
    }
    inputs.push({ type: part.kind, name: part.name, path: part.path });
  }
  return inputs;
}
