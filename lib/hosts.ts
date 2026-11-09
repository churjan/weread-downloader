export const resourceHosts = ['weread.qq.com', 'gfp.tencent-cloud.com', 'myqcloud.com', 'qpic.cn'];
export const hostPermissions = resourceHosts.map(host => `https://*.${host}/*`);

export function resourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !resourceHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
    throw new Error('资源地址不在微信读书允许的域名内');
  }
  return url;
}

// The reader keeps resource timing entries when switching books within a tab.
export function currentPdfResource(resources: string[], bookId: string): string | undefined {
  return resources.findLast(value => {
    try {
      const url = resourceUrl(value);
      return decodeURIComponent(url.pathname.split('/').pop() || '') === bookId + '.pdf';
    } catch { return false; }
  });
}

export function filename(title: string, extension: string): string {
  let name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 100).replace(/[ .]+$/, '') || '微信读书';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = '_' + name;
  return name + '.' + extension;
}
