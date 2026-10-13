// Renders build/icon.svg to build/icon.icns (macOS only: uses iconutil). Run after changing the SVG:
//   pnpm --filter @tabreach/desktop make-icon
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const build = new URL('../build/', import.meta.url).pathname;
const svg = readFileSync(join(build, 'icon.svg'), 'utf8');
const set = join(mkdtempSync(join(tmpdir(), 'tabreach-icon-')), 'icon.iconset');
execFileSync('mkdir', [set]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      await page.setViewportSize({ width: px, height: px });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${svg}`,
      );
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
      await page.screenshot({ path: join(set, name), omitBackground: true });
    }
  }
} finally {
  await browser.close();
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(build, 'icon.icns')]);
rmSync(join(set, '..'), { recursive: true, force: true });
console.log('build/icon.icns written');
