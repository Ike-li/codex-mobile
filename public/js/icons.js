/** 描边图标字典 —— 与 Header/composer inline SVG 同一约定:
 *  viewBox 0 0 24 24 / stroke currentColor / stroke-width 2.2 / round caps.
 *  返回的是可信常量字符串,可直接进 innerHTML;缺名返回空串。 */

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

function svg(inner) {
  return `${SVG_OPEN}${inner}${SVG_CLOSE}`;
}

export const ICONS = {
  compass: svg(
    '<circle cx="12" cy="12" r="9"/>'
    + '<polygon points="14.5 9.5 11 11 9.5 14.5 13 13 14.5 9.5"/>',
  ),
  chart: svg(
    '<path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V8"/>',
  ),
  clipboard: svg(
    '<rect x="7" y="4" width="10" height="16" rx="2"/>'
    + '<path d="M9 4.5h6"/><path d="M9 10h6"/><path d="M9 14h4"/>',
  ),
  search: svg(
    '<circle cx="11" cy="11" r="6.5"/><path d="M16.5 16.5 20 20"/>',
  ),
  copy: svg(
    '<rect x="9" y="9" width="11" height="11" rx="2"/>'
    + '<path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  ),
  notepad: svg(
    '<path d="M7 4h8l3 3v13H7z"/><path d="M15 4v3h3"/><path d="M9 12h6"/><path d="M9 16h4"/>',
  ),
  broom: svg(
    '<path d="M4 20c2-1 4-5 5-8l7-7 3 3-7 7c-3 1-7 3-8 5z"/><path d="M14 6l4 4"/>',
  ),
  shield: svg(
    '<path d="M12 3 5 6v6c0 5 3.2 7.8 7 9 3.8-1.2 7-4 7-9V6l-7-3z"/>',
  ),
  chat: svg(
    '<path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-4 3v-3H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>',
  ),
  tools: svg(
    '<path d="M14.5 5.5a3.5 3.5 0 0 0-4.9 4.9L4 16v4h4l5.6-5.6a3.5 3.5 0 0 0 4.9-4.9L16 12l-2.5-2.5z"/>',
  ),
  warning: svg(
    '<path d="M12 4 3 19h18L12 4z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  ),
  hammer: svg(
    '<path d="M14 5h6v4l-4 2-3-3z"/><path d="M11 10 4 17l3 3 7-7"/>',
  ),
  pencil: svg(
    '<path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="M12 8l4 4"/>',
  ),
  refresh: svg(
    '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  ),
  hand: svg(
    '<path d="M8 11V7a1.5 1.5 0 0 1 3 0v4"/>'
    + '<path d="M11 11V5.5a1.5 1.5 0 0 1 3 0V11"/>'
    + '<path d="M14 11V7a1.5 1.5 0 0 1 3 0v6c0 3-2 5-5 5h-1c-3 0-5-2.5-5-5.5V11"/>'
    + '<path d="M5 12v2.5"/>',
  ),
  eye: svg(
    '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  ),
  skull: svg(
    '<path d="M12 4c-4 0-7 2.8-7 6.5 0 2.2 1.1 4 2.7 5.2V19h8.6v-3.3c1.6-1.2 2.7-3 2.7-5.2C19 6.8 16 4 12 4z"/>'
    + '<circle cx="9.5" cy="11" r="1"/><circle cx="14.5" cy="11" r="1"/><path d="M10 16h4"/>',
  ),
  star: svg(
    '<path d="M12 4l2.2 4.6 5.1.6-3.8 3.4 1.1 5-4.6-2.6-4.6 2.6 1.1-5L4.7 9.2l5.1-.6z"/>',
  ),
  bot: svg(
    '<rect x="5" y="8" width="14" height="10" rx="3"/>'
    + '<path d="M12 5v3"/><circle cx="9.5" cy="13" r="1"/><circle cx="14.5" cy="13" r="1"/>',
  ),
  zap: svg(
    '<path d="M13 3 6 13h5l-1 8 7-10h-5l1-8z"/>',
  ),
  circle: svg(
    '<circle cx="12" cy="12" r="7"/>',
  ),
  plus: svg(
    '<path d="M12 5v14"/><path d="M5 12h14"/>',
  ),
  folder: svg(
    '<path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ),
  file: svg(
    '<path d="M7 4h7l4 4v12H7z"/><path d="M14 4v4h4"/>',
  ),
  folderOpen: svg(
    '<path d="M3 9h7l2 2h9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
    + '<path d="M3 9V7a2 2 0 0 1 2-2h4l2 2"/>',
  ),
  paperclip: svg(
    '<path d="M15.5 8.5 9 15a3 3 0 0 0 4.2 4.2l7.1-7.1a5 5 0 0 0-7.1-7.1L5.5 12.7"/>',
  ),
  pin: svg(
    '<path d="M12 17v4"/><path d="M8 4h8l-1 6h3l-6 6-6-6h3z"/>',
  ),
  check: svg(
    '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  ),
  square: svg(
    '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  ),
  hourglass: svg(
    '<path d="M7 4h10"/><path d="M7 20h10"/><path d="M8 4c0 4 3 5 4 6s4 2 4 6"/><path d="M16 4c0 4-3 5-4 6s-4 2-4 6"/>',
  ),
  question: svg(
    '<circle cx="12" cy="12" r="9"/><path d="M9.8 9.5a2.4 2.4 0 1 1 3.7 2c-.8.6-1.5 1.1-1.5 2.3"/><path d="M12 17h.01"/>',
  ),
  receipt: svg(
    '<path d="M7 4h10v16l-2-1.5L13 20l-2-1.5L9 20l-2-1.5z"/><path d="M9 9h6"/><path d="M9 13h6"/>',
  ),
  x: svg(
    '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  ),
  bellOff: svg(
    '<path d="M7.5 7.5 18 18"/><path d="M10 5a3 3 0 0 1 5.5 1.6c.4 1.7.9 2.6 1.5 4"/><path d="M6.2 10.5C6.7 9 7 7.8 7 6.8"/><path d="M5 18h14"/><path d="M10 18a2 2 0 0 0 4 0"/>',
  ),
  image: svg(
    '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m8 16 3-3 2 2 3-3 2 4"/>',
  ),
  gear: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M4.9 6.5l1.6 1.6M17.5 15.9l1.6 1.6M3 12h2.2M18.8 12H21M4.9 17.5l1.6-1.6M17.5 8.1l1.6-1.6"/>',
  ),
  archive: svg(
    '<rect x="3" y="4" width="18" height="4" rx="1"/>'
    + '<path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  ),
};

export function icon(name, { className } = {}) {
  const markup = ICONS[name];
  if (!markup) return '';
  if (!className) return markup;
  return markup.replace('class="ui-icon"', `class="ui-icon ${className}"`);
}

/** 把 [data-icon="name"] 占位换成描边 SVG。可重复调用(已含 svg 则跳过)。 */
export function hydrateIcons(root = document) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.getAttribute('data-icon');
    if (!name || el.querySelector('svg.ui-icon')) continue;
    const markup = icon(name);
    if (markup) el.innerHTML = markup;
  }
}
