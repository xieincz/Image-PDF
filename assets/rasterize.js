/**
 * rasterize.js — 共享的「PDF → 图片 PDF」引擎。
 *
 * 这个模块不碰 UI，也不假设自己运行在哪里：
 *  - 在 Web Worker 里跑时用 OffscreenCanvas（界面完全不卡）；
 *  - 在主线程里跑时用 HTMLCanvasElement（作为兜底方案）。
 * 调用方负责把 pdf.js 和 pdf-lib 传进来，因此本模块在两种环境下都能用。
 *
 * 流程：pdf.js 逐页渲染到画布 → 编码 JPEG/PNG → pdf-lib 把图片原样嵌入新 PDF。
 */

/** 保守的画布上限：超过就自动降分辨率，避免浏览器直接失败（各浏览器上限不同）。 */
export const DEFAULT_LIMITS = Object.freeze({ maxSide: 16384, maxPixels: 150e6 });

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ------------------------------------------------------------------ *
 * 画布工厂
 * ------------------------------------------------------------------ */

/**
 * pdf.js 会在渲染内部图形（蒙版、图案、位图缩放）时自己创建画布，
 * 它需要一个 CanvasFactory。默认实现依赖 document，所以在 Worker 里必须换成
 * OffscreenCanvas 版本。这里把两种实现做成同一个基类的子类。
 */
class BaseCanvasFactory {
  #enableHWA = false;

  constructor({ enableHWA = false } = {}) {
    this.#enableHWA = enableHWA;
  }

  /** 内部用的临时画布（pdf.js 会调用）。 */
  create(width, height) {
    const canvas = this._createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext('2d', { willReadFrequently: !this.#enableHWA }),
    };
  }

  reset(entry, width, height) {
    if (!entry?.canvas) throw new Error('Canvas is not specified');
    if (!(width > 0 && height > 0)) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry) {
    if (!entry?.canvas) throw new Error('Canvas is not specified');
    entry.canvas.width = 1;
    entry.canvas.height = 1;
    entry.canvas = null;
    entry.context = null;
  }

  getNoAlphaContext(canvas) {
    return canvas.getContext('2d', { alpha: false, willReadFrequently: !this.#enableHWA });
  }

  /** 我们自己的「一页一张」目标画布：不透明，走硬件加速。 */
  createTarget(width, height) {
    const canvas = this._createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { alpha: false }) };
  }

  destroyTarget(entry) {
    if (!entry) return;
    entry.canvas.width = 1;
    entry.canvas.height = 1;
    entry.canvas = null;
    entry.context = null;
  }

  _createCanvas() {
    throw new Error('未实现的画布工厂');
  }
}

/** 主线程 / DOM 环境。 */
export class DomCanvasFactory extends BaseCanvasFactory {
  _createCanvas(width, height) {
    if (!(width > 0 && height > 0)) throw new Error('Invalid canvas size');
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(width);
    canvas.height = Math.floor(height);
    return canvas;
  }
}

/** Worker 环境。 */
export class OffscreenCanvasFactory extends BaseCanvasFactory {
  _createCanvas(width, height) {
    if (!(width > 0 && height > 0)) throw new Error('Invalid canvas size');
    return new OffscreenCanvas(Math.floor(width), Math.floor(height));
  }
}

/**
 * Worker 里没有 DOM，pdf.js 默认的 DOMFilterFactory 会去碰 document，
 * 所以换成空实现（返回 "none" 表示不加滤镜）。代价是极少数使用
 * 透明蒙版（knockout）的 PDF 在 Worker 模式下细节略有差异，
 * 主线程模式不受影响。
 */
export class NoopFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() {}
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/** 只检查写法是否合法（不看页数），用于输入框即时校验。 */
export function isRangeSyntaxValid(spec) {
  const text = String(spec ?? '').trim();
  if (!text) return true;
  return text
    .split(/[,，;；\s]+/)
    .filter(Boolean)
    .every((part) => /^(\d+)?\s*(?:[-–~]\s*(\d+)?)?$/.test(part) && /\d/.test(part));
}

/**
 * 把 "1-3,5,8-" 解析成页码数组。
 * 返回 { pages, error }；pages 为 null 表示「全部页」。
 */
export function parsePageRanges(spec, totalPages) {
  const text = String(spec ?? '').trim();
  if (!text) return { pages: null, error: null };

  const pages = [];
  const seen = new Set();

  for (const rawPart of text.split(/[,，;；\s]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = /^(\d+)?\s*(?:[-–~]\s*(\d+)?)?$/.exec(part);
    if (!match || (!match[1] && !match[2])) {
      return { pages: null, error: `无法识别的页码写法：「${part}」` };
    }
    let start = match[1] ? Number.parseInt(match[1], 10) : 1;
    const isRange = /[-–~]/.test(part);
    let end = match[2]
      ? Number.parseInt(match[2], 10)
      : (isRange ? totalPages : start);
    if (end < start) [start, end] = [end, start];
    for (let p = start; p <= end; p += 1) {
      if (p >= 1 && p <= totalPages && !seen.has(p)) {
        seen.add(p);
        pages.push(p);
      }
    }
  }

  if (!pages.length) return { pages: null, error: '页面范围没有匹配到任何页' };
  pages.sort((a, b) => a - b);
  return { pages, error: null };
}

/**
 * 计算某页在指定 DPI 下的栅格化参数，并在超出画布上限时自动降级。
 * widthPt / heightPt 用 scale=1 的 viewport 尺寸（即页面自身尺寸，单位 pt）。
 */
export function planRaster(widthPt, heightPt, dpi, limits = DEFAULT_LIMITS) {
  const ideal = dpi / 72;
  let factor = 1;

  const longestSide = Math.max(widthPt, heightPt) * ideal;
  if (limits.maxSide > 0 && longestSide > limits.maxSide) {
    factor = Math.min(factor, limits.maxSide / longestSide);
  }

  const pixels = widthPt * ideal * heightPt * ideal;
  if (limits.maxPixels > 0 && pixels > limits.maxPixels) {
    factor = Math.min(factor, Math.sqrt(limits.maxPixels / pixels));
  }
  if (!(factor > 0)) factor = 1e-6;

  const scale = ideal * factor;
  return {
    scale,
    pxW: Math.max(1, Math.floor(widthPt * scale)),
    pxH: Math.max(1, Math.floor(heightPt * scale)),
    effectiveDpi: dpi * factor,
    clamped: factor < 0.999,
  };
}

/** 画布 → Blob，兼容 OffscreenCanvas 与 HTMLCanvasElement。 */
export async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('图片编码失败：页面可能过大导致内存不足'));
      },
      type,
      quality,
    );
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 把 PDF 的指定页渲染成图片并组装为新的 PDF。
 *
 * @param {object}   opts
 * @param {object}   opts.pdfjsLib      pdf.js 模块命名空间
 * @param {Function} opts.PDFDocument   pdf-lib 的 PDFDocument
 * @param {Uint8Array} opts.data        PDF 字节
 * @param {number}   [opts.dpi=600]     目标分辨率
 * @param {'jpeg'|'png'} [opts.format]  图片格式
 * @param {number}   [opts.quality]     JPEG 质量 0-1
 * @param {string}   [opts.pageSpec]    页码表达式，空 = 全部
 * @param {'worker'|'dom'} [opts.mode]  运行环境
 * @param {object}   [opts.limits]      画布上限
 * @param {object}   [opts.libraries]   { cMapUrl, standardFontDataUrl, wasmUrl, iccUrl }
 * @param {string}   [opts.title]       输出 PDF 标题
 * @param {Function} [opts.onEvent]     进度回调
 * @param {Function} [opts.isCancelled] 是否已取消
 * @param {boolean}  [opts.wantPreview] 是否在事件里附带每页 Blob（用于生成缩略图）
 * @returns {Promise<{cancelled:boolean, bytes?:Uint8Array, pages?:Array, warnings?:string[]}>}
 */
export async function rasterizePdf({
  pdfjsLib,
  PDFDocument,
  data,
  dpi = 600,
  format = 'jpeg',
  quality = 0.92,
  pageSpec = '',
  mode = 'dom',
  limits = DEFAULT_LIMITS,
  libraries = {},
  title = null,
  onEvent = () => {},
  isCancelled = () => false,
  wantPreview = false,
}) {
  const warnings = [];
  const emit = (event) => onEvent(event);
  const startedAll = now();

  const Factory = mode === 'worker' ? OffscreenCanvasFactory : DomCanvasFactory;
  const factory = new Factory();

  emit({ type: 'stage', stage: 'open', message: '正在解析 PDF…' });

  const loadingTask = pdfjsLib.getDocument({
    data,
    CanvasFactory: Factory,
    // Worker 里没有 document，必须换掉依赖 DOM 的滤镜工厂。
    ...(mode === 'worker' ? { FilterFactory: NoopFilterFactory } : {}),
    // Worker 里无法使用 FontFace/@font-face，改用字形轮廓绘制（和 Node 环境一致），
    // 效果是矢量级别的，反而更忠实于原文件。
    disableFontFace: mode === 'worker',
    // 让 PDF 内部线程自己抓取 cmap / 标准字体 / wasm，省掉主线程中转。
    useWorkerFetch: true,
    cMapUrl: libraries.cMapUrl ?? null,
    standardFontDataUrl: libraries.standardFontDataUrl ?? null,
    wasmUrl: libraries.wasmUrl ?? null,
    iccUrl: libraries.iccUrl ?? null,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new Error('这个 PDF 有密码保护，本工具暂不支持加密文件');
    }
    if (error?.name === 'InvalidPDFException') {
      throw new Error('文件不是有效的 PDF，或者已经损坏');
    }
    throw error;
  }

  const totalInDoc = doc.numPages;
  emit({ type: 'opened', totalInDoc, message: `共 ${totalInDoc} 页` });

  const { pages: parsedPages, error: rangeError } = parsePageRanges(pageSpec, totalInDoc);
  if (rangeError) {
    await safeDestroy(doc);
    throw new Error(rangeError);
  }
  const picked = parsedPages ?? Array.from({ length: totalInDoc }, (_, i) => i + 1);

  const outPdf = await PDFDocument.create();
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const total = picked.length;
  const pageStats = [];

  for (let i = 0; i < total; i += 1) {
    if (isCancelled()) {
      await safeDestroy(doc);
      return { cancelled: true, warnings };
    }

    const index = i + 1;
    const pageNumber = picked[i];
    const pageStarted = now();

    emit({ type: 'page-start', index, total, pageNumber, stage: 'render', message: `正在渲染第 ${pageNumber} 页` });

    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const plan = planRaster(base.width, base.height, dpi, limits);

    if (plan.clamped) {
      const note = `第 ${pageNumber} 页超出浏览器画布上限，已自动降到约 ${Math.round(plan.effectiveDpi)} dpi`;
      warnings.push(note);
      emit({ type: 'warning', message: note, pageNumber });
    }

    const viewport = page.getViewport({ scale: plan.scale });
    const entry = factory.createTarget(plan.pxW, plan.pxH);
    const ctx = entry.context;

    // 先铺白：JPEG 没有透明通道，透明像素会被压成黑色。
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, plan.pxW, plan.pxH);

    const task = page.render({
      canvasContext: ctx,
      viewport,
      background: '#ffffff',
    });

    // 主线程模式下让出控制权，界面才不会整页渲染期间假死。
    if (mode === 'dom') {
      task.onContinue = (next) => {
        if (isCancelled()) return;
        setTimeout(next, 0);
      };
    }

    currentRenderTask = task;
    try {
      await task.promise;
    } catch (error) {
      factory.destroyTarget(entry);
      await safeDestroy(doc);
      if (error?.name === 'RenderingCancelledException') {
        return { cancelled: true, warnings };
      }
      throw error;
    } finally {
      currentRenderTask = null;
    }

    emit({
      type: 'page-progress',
      index,
      total,
      pageNumber,
      stage: 'encode',
      pxW: plan.pxW,
      pxH: plan.pxH,
      dpi: plan.effectiveDpi,
      message: `正在编码第 ${pageNumber} 页（${plan.pxW}×${plan.pxH}）`,
    });

    const blob = await canvasToBlob(entry.canvas, mime, format === 'jpeg' ? quality : undefined);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const image = format === 'png'
      ? await outPdf.embedPng(bytes)
      : await outPdf.embedJpg(bytes);

    // 页面尺寸保持原样（PDF 单位 pt），图片铺满整页 —— 相当于「按页导出图片再合成」。
    const outPage = outPdf.addPage([base.width, base.height]);
    outPage.drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });

    if (typeof page.cleanup === 'function') page.cleanup();
    factory.destroyTarget(entry);

    const ms = now() - pageStarted;
    pageStats.push({
      pageNumber,
      ms,
      bytes: bytes.length,
      pxW: plan.pxW,
      pxH: plan.pxH,
      dpi: plan.effectiveDpi,
      widthPt: base.width,
      heightPt: base.height,
    });

    const averageMs = pageStats.reduce((sum, s) => sum + s.ms, 0) / pageStats.length;
    emit({
      type: 'page-done',
      index,
      total,
      pageNumber,
      ms,
      averageMs,
      remainingMs: averageMs * (total - index),
      bytes: bytes.length,
      pxW: plan.pxW,
      pxH: plan.pxH,
      dpi: plan.effectiveDpi,
      blob: wantPreview ? blob : undefined,
      message: `第 ${pageNumber} 页完成`,
    });
  }

  emit({ type: 'stage', stage: 'assemble', message: '正在组装 PDF…' });

  outPdf.setProducer('image-pdf (pdf.js + pdf-lib)');
  outPdf.setCreator('image-pdf');
  const stamp = new Date();
  outPdf.setCreationDate(stamp);
  outPdf.setModificationDate(stamp);
  if (title) outPdf.setTitle(title);

  const outBytes = await outPdf.save({ useObjectStreams: true, addDefaultPage: false });
  await safeDestroy(doc);

  return {
    cancelled: false,
    bytes: outBytes,
    pages: pageStats,
    warnings,
    elapsedMs: now() - startedAll,
  };
}

/** 当前正在渲染的任务，取消时用来打断。 */
let currentRenderTask = null;

/** 取消当前页的渲染（若正在进行）。 */
export function abortCurrentRender() {
  try {
    currentRenderTask?.cancel?.();
  } catch {
    /* 忽略 */
  }
}

async function safeDestroy(doc) {
  try {
    await doc?.destroy?.();
  } catch {
    /* 忽略清理阶段的错误 */
  }
}
