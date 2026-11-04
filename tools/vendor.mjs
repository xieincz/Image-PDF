#!/usr/bin/env node
/**
 * 从 node_modules 刷新 vendor/ 里的运行时依赖。
 * 升级 pdf.js / pdf-lib 之后跑一次：node tools/vendor.mjs
 */
import { cp, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const NM = join(ROOT, 'node_modules');

const FILES = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.js'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.js'],
  ['pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.js'],
  ['pdfjs-dist/LICENSE', 'LICENSE.pdfjs'],
  ['pdf-lib/LICENSE.md', 'LICENSE.pdf-lib.md'],
];

const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

async function main() {
  await mkdir(VENDOR, { recursive: true });

  for (const [src, dest] of FILES) {
    const from = join(NM, src);
    await stat(from);
    await copyFile(from, join(VENDOR, dest));
    console.log(`✓ ${src} → vendor/${dest}`);
  }

  for (const dir of DIRS) {
    const from = join(NM, 'pdfjs-dist', dir);
    await stat(from);
    const to = join(VENDOR, dir);
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
    console.log(`✓ pdfjs-dist/${dir} → vendor/${dir}`);
  }

  console.log('\nvendor/ 已是最新。');
}

main().catch((error) => {
  console.error('刷新失败：', error.message);
  process.exitCode = 1;
});
