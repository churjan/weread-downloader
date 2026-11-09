import { defineConfig } from 'wxt';
import { hostPermissions } from './lib/hosts';

export default defineConfig({
  manifest: {
    name: '微信读书下载',
    minimum_chrome_version: '116',
    description: '在阅读页下载当前书籍，自动识别 EPUB、TXT 和 PDF。',
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    action: {
      default_title: '微信读书下载',
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        128: 'icons/128.png',
      },
    },
    permissions: ['downloads', 'storage'],
    host_permissions: hostPermissions,
  },
});
