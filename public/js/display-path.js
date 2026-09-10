// 路径在界面上的显示形态。
//
// 界面上出现宿主机绝对路径是一条横切的失败判据：/Users/<用户名>/… 会把网关
// 运行者的身份和目录结构一起送到浏览器里，而浏览器可能正跑在另一台设备上、
// 由别人拿着。
export function compactPath(path) {
  if (!path) return '';
  const parts = String(path).split('/').filter(Boolean);
  // 两段以内本来就不含身份信息，缩了反而更难读。
  if (parts.length <= 2) return path;
  return '…/' + parts.slice(-2).join('/');
}

/** 上一级目录；已在根目录时返回 null，让调用方据此禁用「向上」入口。 */
export function parentPath(path) {
  const clean = String(path || '').replace(/\/+$/, '');
  if (!clean || clean === '/') return null;
  const idx = clean.lastIndexOf('/');
  return idx <= 0 ? '/' : clean.slice(0, idx);
}
