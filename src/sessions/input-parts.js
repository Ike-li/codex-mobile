import { realpath, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isAbsolute, relative, sep } from 'node:path';
import { isPublicEndpointHostname, isPublicIpAddress } from '../shared/network-address.js';

export async function resolveInputParts(parts, {
  cwd,
  skillEntries = [],
  allowRemoteImages = false,
  resolveHostname = defaultResolveHostname,
} = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  if (typeof cwd !== 'string' || !cwd) throw new Error('Input parts require a runtime cwd');

  const root = await realpath(cwd);
  const enabledSkills = skillEntries.flatMap(entry => entry?.skills || [])
    .filter(skill => skill?.enabled === true);
  const resolved = [];
  for (const part of parts) {
    if (part?.kind === 'imageUrl') {
      if (!allowRemoteImages) throw new Error('Remote image URLs are disabled');
      const image = await resolveRemoteImage(part, resolveHostname);
      resolved.push(image);
      continue;
    }
    if (part?.kind === 'skill') {
      const skill = enabledSkills.find(candidate => (
        candidate.name === part.name && candidate.path === part.path
      ));
      if (!skill) throw new Error('Skill is not enabled or was not returned by skills/list');
      resolved.push({ kind: 'skill', name: skill.name, path: skill.path });
      continue;
    }
    if (part?.kind !== 'mention') {
      throw new Error(`Unsupported input part kind: ${part?.kind || 'missing'}`);
    }
    if (typeof part.path !== 'string' || !part.path) {
      throw new Error('Mention path is required');
    }
    const path = await realpath(part.path);
    const relativePath = relative(root, path);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('Mention path must stay inside the runtime cwd');
    }
    const file = await stat(path);
    if (!file.isFile()) throw new Error('Mention path must reference a file');
    resolved.push({
      kind: 'mention',
      name: relativePath.split(sep).join('/'),
      path,
    });
  }
  return resolved;
}

async function resolveRemoteImage(part, resolveHostname) {
  if (typeof part.url !== 'string' || !part.url || part.url.length > 2048) {
    throw new Error('Remote image URL is invalid');
  }
  let url;
  try {
    url = new URL(part.url);
  } catch {
    throw new Error('Remote image URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Remote image URL must use HTTPS without credentials');
  }
  const hostname = url.hostname.toLowerCase();
  if (!isPublicEndpointHostname(hostname)) {
    throw new Error('Remote image hostname is not allowed');
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveHostname(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(address => !isPublicIpAddress(address))) {
    throw new Error('Remote image hostname resolves to a non-public address');
  }
  if (part.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(part.detail)) {
    throw new Error('Remote image detail is invalid');
  }
  return {
    kind: 'imageUrl',
    url: url.href,
    ...(part.detail ? { detail: part.detail } : {}),
  };
}

async function defaultResolveHostname(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}
