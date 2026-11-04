/**
 * render-worker.js —— 在后台线程里完成「渲染 + 组装」。
 *
 * 关键点：先 import pdf.worker.js，它会把 WorkerMessageHandler 挂到
 * globalThis.pdfjsWorker 上；pdf.js 检测到这个全局变量后就地运行解析器，
 * 不再创建嵌套 Worker（部分浏览器不支持嵌套 Worker，这样最稳）。
 */
// 这里用同一个包装入口：Worker 是独立 realm，补丁必须在 pdf.worker.js 之前装上
import './pdf-worker.js';
import * as pdfjsLib from '../vendor/pdf.js';
import { PDFDocument } from '../vendor/pdf-lib.js';
import { rasterizePdf, abortCurrentRender } from './rasterize.js';

const VENDOR = {
  cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
  wasmUrl: new URL('../vendor/wasm/', import.meta.url).href,
  iccUrl: new URL('../vendor/iccs/', import.meta.url).href,
};

const PREVIEW_WIDTH = 420;

let cancelled = false;
let busy = false;
// 缩略图是异步生成的：让 done 等它发完，主线程才能在结果出现时就画好缩略图。
let previewChain = Promise.resolve();

self.addEventListener('message', (event) => {
  const msg = event.data || {};

  if (msg.cmd === 'ping') {
    self.postMessage({
      type: 'pong',
      offscreen: typeof OffscreenCanvas !== 'undefined',
      version: pdfjsLib.version,
    });
    return;
  }

  if (msg.cmd === 'cancel') {
    cancelled = true;
    abortCurrentRender();
    return;
  }

  if (msg.cmd === 'convert') {
    if (busy) {
      self.postMessage({ type: 'error', message: '上一个任务还在处理中' });
      return;
    }
    void runConvert(msg);
  }
});

async function runConvert(msg) {
  busy = true;
  cancelled = false;

  const { bytes, options = {} } = msg;

  try {
    const result = await rasterizePdf({
      pdfjsLib,
      PDFDocument,
      data: new Uint8Array(bytes),
      dpi: options.dpi,
      format: options.format,
      quality: options.quality,
      pageSpec: options.pageSpec,
      mode: 'worker',
      limits: options.limits,
      libraries: VENDOR,
      title: options.title,
      wantPreview: true,
      isCancelled: () => cancelled,
      onEvent: handleEvent,
    });

    if (cancelled || result.cancelled) {
      cancelled = false;
      self.postMessage({ type: 'cancelled' });
      return;
    }

    await previewChain; // 最后一页的缩略图也要先送到主线程
    previewChain = Promise.resolve();

    const out = result.bytes;
    self.postMessage(
      {
        type: 'done',
        bytes: out.buffer,
        pages: result.pages,
        warnings: result.warnings,
        elapsedMs: result.elapsedMs,
      },
      [out.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      name: error?.name,
      message: error?.message || String(error),
      stack: error?.stack,
    });
  } finally {
    busy = false;
  }
}

/**
 * 把引擎事件转发给主线程。顺带把每页图片压成小缩略图，
 * 让主线程可以显示「正在处理的这一页」。
 */
function handleEvent(event) {
  if (event.type !== 'page-done' || !event.blob || typeof createImageBitmap !== 'function') {
    const { blob, ...rest } = event;
    self.postMessage({ type: 'progress', event: rest });
    return;
  }

  const blob = event.blob;
  const { blob: _unused, ...rest } = event;
  const width = Math.max(32, Math.min(PREVIEW_WIDTH, event.pxW || PREVIEW_WIDTH));

  previewChain = previewChain
    .then(() => createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'low' }))
    .then((bitmap) => {
      self.postMessage({ type: 'progress', event: { ...rest, preview: bitmap } }, [bitmap]);
    })
    .catch(() => {
      self.postMessage({ type: 'progress', event: rest });
    });
}
