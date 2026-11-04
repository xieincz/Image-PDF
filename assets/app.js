/**
 * app.js —— 页面逻辑：界面、进度、引擎选择、下载。
 *
 * 默认在 Web Worker 里跑（界面完全不卡）；如果浏览器不支持
 * module worker / OffscreenCanvas，或者后台线程出错，就自动退回主线程模式。
 */
// 必须排在 pdf.js / pdf-lib 之前：先补齐老浏览器缺的 Uint8Array hex / base64 方法
import './compat.js';
import {
  rasterizePdf,
  abortCurrentRender,
  formatBytes,
  formatDuration,
  isRangeSyntaxValid,
  DEFAULT_LIMITS,
} from './rasterize.js';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('errorBox'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  fileBox: $('fileBox'),
  fileName: $('fileName'),
  fileMeta: $('fileMeta'),
  clearFileBtn: $('clearFileBtn'),
  optionsCard: $('optionsCard'),
  pickCard: $('pickCard'),
  dpi: $('dpi'),
  customDpi: $('customDpi'),
  customDpiField: $('customDpiField'),
  dpiHelp: $('dpiHelp'),
  format: $('format'),
  formatHelp: $('formatHelp'),
  quality: $('quality'),
  qualityField: $('qualityField'),
  qualityOut: $('qualityOut'),
  pageRange: $('pageRange'),
  rangeHelp: $('rangeHelp'),
  outName: $('outName'),
  engineNote: $('engineNote'),
  startBtn: $('startBtn'),
  cancelBtn: $('cancelBtn'),
  progressCard: $('progressCard'),
  progressBar: $('progressBar'),
  barFill: $('barFill'),
  progressPct: $('progressPct'),
  progressStage: $('progressStage'),
  statPages: $('statPages'),
  statDpi: $('statDpi'),
  statElapsed: $('statElapsed'),
  statEta: $('statEta'),
  preview: $('preview'),
  previewCaption: $('previewCaption'),
  log: $('log'),
  resultCard: $('resultCard'),
  resultSummary: $('resultSummary'),
  downloadLink: $('downloadLink'),
  againBtn: $('againBtn'),
};

const SETTINGS_KEY = 'image-pdf-settings-v1';

/** 调试用的 URL 参数：?engine=main|worker &maxSide= &maxPixels= */
const params = new URLSearchParams(location.search);
const forcedEngine = params.get('engine');
const limits = {
  maxSide: Number(params.get('maxSide')) > 0 ? Number(params.get('maxSide')) : DEFAULT_LIMITS.maxSide,
  maxPixels: Number(params.get('maxPixels')) > 0 ? Number(params.get('maxPixels')) : DEFAULT_LIMITS.maxPixels,
};

let currentFile = null;
let running = false;
let cancelled = false;
let activeEngine = null; // 'worker' | 'main'
let workerPromise = null;
let objectUrl = null;
let elapsedTimer = 0;

/* ------------------------------------------------------------------ *
 * 设置项的读写
 * ------------------------------------------------------------------ */

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const dpiValue = saved.dpi ?? '600';
  if ([...els.dpi.options].some((o) => o.value === String(dpiValue))) els.dpi.value = String(dpiValue);
  if (saved.customDpi) els.customDpi.value = saved.customDpi;
  if (saved.format === 'png' || saved.format === 'jpeg') els.format.value = saved.format;
  if (typeof saved.quality === 'number') els.quality.value = String(saved.quality);
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        dpi: els.dpi.value,
        customDpi: els.customDpi.value,
        format: els.format.value,
        quality: Number(els.quality.value),
      }),
    );
  } catch {
    /* 隐私模式下写不了，忽略 */
  }
}

function readOptions() {
  const dpi = els.dpi.value === 'custom'
    ? Math.min(2400, Math.max(50, Number(els.customDpi.value) || 600))
    : Number(els.dpi.value);
  return {
    dpi,
    format: els.format.value === 'png' ? 'png' : 'jpeg',
    quality: Number(els.quality.value) || 0.92,
    pageSpec: els.pageRange.value.trim(),
    limits,
  };
}

/* ------------------------------------------------------------------ *
 * 界面辅助
 * ------------------------------------------------------------------ */

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = !message;
}

function logLine(text, kind = '') {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.textContent = text;
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;
}

function clearLog() {
  els.log.textContent = '';
}

function setStage(text) {
  els.progressStage.textContent = text;
}

function setBar(fraction) {
  const pct = Math.max(0, Math.min(1, fraction));
  els.barFill.style.width = `${(pct * 100).toFixed(1)}%`;
  els.progressPct.textContent = `${Math.round(pct * 100)}%`;
  els.progressBar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
}

/* ------------------------------------------------------------------ *
 * 进度：按页推进 + 页内按时间平滑插值
 * ------------------------------------------------------------------ */

const progress = {
  total: 0,
  completed: 0,
  pageStart: 0,
  pageFloor: 0,
  expectedMs: 1500,
  assembling: false,
  assembleStart: 0,
  raf: 0,
};

function fractionNow() {
  if (!progress.total) return 0;
  if (progress.assembling) {
    const extra = Math.min(0.03, Math.max(0, (performance.now() - progress.assembleStart) / 4000) * 0.03);
    return Math.min(0.995, 0.965 + extra);
  }
  const elapsed = performance.now() - progress.pageStart;
  const withinPage = Math.min(0.96, Math.max(progress.pageFloor, elapsed / Math.max(300, progress.expectedMs)));
  return Math.min(1, (progress.completed + withinPage) / progress.total);
}

function tickProgress() {
  if (!running) return;
  setBar(fractionNow());
  progress.raf = requestAnimationFrame(tickProgress);
}

function startTicking() {
  cancelAnimationFrame(progress.raf);
  progress.raf = requestAnimationFrame(tickProgress);
}

function stopTicking() {
  cancelAnimationFrame(progress.raf);
  progress.raf = 0;
}

function refreshEta(elapsedMs) {
  els.statElapsed.textContent = formatDuration(elapsedMs);
  if (!progress.total || progress.completed === 0) {
    els.statEta.textContent = '估算中…';
    return;
  }
  const perPage = (elapsedMs - 0) / Math.max(1, progress.completed);
  const remaining = Math.max(0, progress.total - progress.completed) * perPage;
  els.statEta.textContent = progress.completed >= progress.total ? '—' : `约 ${formatDuration(remaining)}`;
}

function startElapsedTimer() {
  const t0 = performance.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => refreshEta(performance.now() - t0), 400);
  return () => {
    clearInterval(elapsedTimer);
    elapsedTimer = 0;
    els.statElapsed.textContent = formatDuration(performance.now() - t0);
  };
}

/* ------------------------------------------------------------------ *
 * 页面缩略图
 * ------------------------------------------------------------------ */

let lastPreviewBitmap = null;
// 缩略图是异步画上去的：收尾前等它们画完，避免结果面板出现时缩略图还是空的。
const pendingPreviews = new Set();

function trackPreview(task) {
  pendingPreviews.add(task);
  void task.finally(() => pendingPreviews.delete(task));
}

async function flushPreviews() {
  while (pendingPreviews.size) await Promise.all([...pendingPreviews]);
}

async function showPreview(bitmapOrBlob, caption) {
  try {
    const bitmap = bitmapOrBlob instanceof Blob
      ? await createImageBitmap(bitmapOrBlob)
      : bitmapOrBlob;
    if (!bitmap) return;
    lastPreviewBitmap?.close?.();
    lastPreviewBitmap = bitmap;

    const maxWidth = 380;
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    els.preview.width = w;
    els.preview.height = h;
    const ctx = els.preview.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    els.previewCaption.textContent = caption;
  } catch {
    /* 缩略图失败不影响主流程 */
  }
}

/* ------------------------------------------------------------------ *
 * Worker 握手
 * ------------------------------------------------------------------ */

function startWorker() {
  return new Promise((resolve) => {
    if (forcedEngine === 'main' || typeof Worker === 'undefined') {
      resolve(null);
      return;
    }

    let worker;
    try {
      worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(null);
    }, 15000);

    function cleanup() {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onError);
    }

    function onMessage(event) {
      if (event.data?.type === 'pong') {
        cleanup();
        resolve(event.data.offscreen ? worker : null);
      }
    }

    function onError() {
      cleanup();
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(null);
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onError);
    worker.postMessage({ cmd: 'ping' });
  });
}

function getWorker() {
  if (forcedEngine === 'main') return Promise.resolve(null);
  if (!workerPromise) workerPromise = startWorker();
  return workerPromise;
}

// 退回主线程的原因有三种，得分开说，别一股脑甩锅给浏览器
// （后台线程抛异常时，浏览器其实是支持 Worker 的，比如 Chromium 134）。
let fallbackReason = null;

function setEngineNote() {
  if (activeEngine === 'worker') {
    els.engineNote.textContent = '渲染线程：后台 Worker（渲染时界面依然流畅）';
    els.engineNote.classList.remove('warn');
    return;
  }
  const notes = {
    forced: '渲染线程：主线程（已用 ?engine=main 指定，渲染大图时界面会略卡）',
    workerError: '渲染线程：主线程（后台线程出错后自动回退，渲染大图时界面会略卡）',
    unsupported: '渲染线程：主线程（此浏览器不支持后台 Worker / OffscreenCanvas，渲染大图时界面会略卡）',
  };
  els.engineNote.textContent = notes[fallbackReason] || notes.unsupported;
  els.engineNote.classList.add('warn');
}

/* ------------------------------------------------------------------ *
 * 文件选择
 * ------------------------------------------------------------------ */

function isPdfFile(file) {
  return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

function acceptFile(file) {
  if (!isPdfFile(file)) {
    showError('请选择 PDF 文件（.pdf）');
    return;
  }
  showError('');
  currentFile = file;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)}${file.lastModified ? ` · 修改于 ${new Date(file.lastModified).toLocaleString()}` : ''}`;
  els.fileBox.hidden = false;
  els.optionsCard.hidden = false;
  els.resultCard.hidden = true;
  els.progressCard.hidden = true;
  els.startBtn.disabled = false;
  els.rangeHelp.textContent = '支持 1-3,5,8- 这样的写法。';
  updateStartState();
}

function clearFile() {
  currentFile = null;
  els.fileInput.value = '';
  els.fileBox.hidden = true;
  els.optionsCard.hidden = true;
  els.resultCard.hidden = true;
  els.progressCard.hidden = true;
  showError('');
  updateStartState();
}

function updateStartState() {
  const rangeOk = isRangeSyntaxValid(els.pageRange.value);
  els.startBtn.disabled = running || !currentFile || !rangeOk;
  els.pageRange.style.borderColor = rangeOk ? '' : 'var(--err)';
}

function outputFileName() {
  const typed = els.outName.value.trim();
  if (typed) return /\.pdf$/i.test(typed) ? typed : `${typed}.pdf`;
  const base = (currentFile?.name || 'output').replace(/\.pdf$/i, '');
  return `${base}-${readOptions().dpi}dpi-image.pdf`;
}

/* ------------------------------------------------------------------ *
 * 转换
 * ------------------------------------------------------------------ */

function handleEngineEvent(event) {
  switch (event.type) {
    case 'stage':
      setStage(event.message || '处理中…');
      if (event.stage === 'assemble') {
        progress.assembling = true;
        progress.assembleStart = performance.now();
      }
      if (event.stage === 'open') logLine('开始解析 PDF…');
      break;

    case 'opened':
      progress.total = progress.total || 0;
      els.rangeHelp.textContent = `共 ${event.totalInDoc} 页；支持 1-3,5,8- 这样的写法。`;
      logLine(`文档共 ${event.totalInDoc} 页`, 'done');
      break;

    case 'warning':
      logLine(event.message, 'warn');
      break;

    case 'page-start':
      if (!progress.total) progress.total = event.total;
      progress.pageStart = performance.now();
      progress.pageFloor = 0;
      setStage(`${event.message}（${event.index}/${event.total}）`);
      els.statPages.textContent = `${event.index} / ${event.total}`;
      break;

    case 'page-progress':
      progress.pageFloor = 0.72;
      els.statDpi.textContent = `${Math.round(event.dpi)} dpi`;
      setStage(`${event.message}（${event.index}/${event.total}）`);
      break;

    case 'page-done': {
      progress.completed = event.index;
      progress.expectedMs = Math.max(400, event.averageMs || progress.expectedMs);
      progress.pageStart = performance.now();
      progress.pageFloor = 0;
      els.statDpi.textContent = `${Math.round(event.dpi)} dpi`;
      logLine(
        `第 ${event.pageNumber} 页：${event.pxW}×${event.pxH} px · ${Math.round(event.dpi)} dpi · ${formatBytes(event.bytes)} · ${(event.ms / 1000).toFixed(1)}s`,
        'done',
      );
      if (event.preview || event.blob) {
        trackPreview(showPreview(event.preview || event.blob, `第 ${event.pageNumber} 页 · ${event.pxW}×${event.pxH}`));
      }
      break;
    }

    default:
      break;
  }
}

function runWithWorker(worker, bytes, options) {
  return new Promise((resolve, reject) => {
    let completedAnyPage = false;

    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'progress') {
        if (msg.event?.type === 'page-done') completedAnyPage = true;
        handleEngineEvent(msg.event);
        return;
      }
      cleanup();
      if (msg.type === 'done') {
        resolve({ bytes: new Uint8Array(msg.bytes), pages: msg.pages, warnings: msg.warnings, elapsedMs: msg.elapsedMs });
      } else if (msg.type === 'cancelled') {
        resolve({ cancelled: true });
      } else if (msg.type === 'error') {
        const error = new Error(msg.message || '后台线程出错');
        error.fromWorker = true;
        error.workerStack = msg.stack;
        error.completedAnyPage = completedAnyPage;
        reject(error);
      }
    };

    const onError = (event) => {
      cleanup();
      const error = new Error(event?.message || '后台线程异常退出');
      error.fromWorker = true;
      error.completedAnyPage = completedAnyPage;
      reject(error);
    };

    function cleanup() {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onError);
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onError);
    worker.postMessage({ cmd: 'convert', bytes: bytes.buffer, options }, [bytes.buffer]);
  });
}

async function loadMainLibs() {
  const [pdfjsLib, pdfLib] = await Promise.all([
    import('../vendor/pdf.js'),
    import('../vendor/pdf-lib.js'),
  ]);
  // 指到自己的包一层：pdf.js 会拿它 new Worker，那个 realm 需要先打 compat 补丁
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf-worker.js', import.meta.url).href;
  return { pdfjsLib, PDFDocument: pdfLib.PDFDocument };
}

async function runOnMainThread(bytes, options) {
  const { pdfjsLib, PDFDocument } = await loadMainLibs();
  return rasterizePdf({
    pdfjsLib,
    PDFDocument,
    data: bytes,
    dpi: options.dpi,
    format: options.format,
    quality: options.quality,
    pageSpec: options.pageSpec,
    mode: 'dom',
    limits: options.limits,
    libraries: {
      cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
      standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('../vendor/wasm/', import.meta.url).href,
      iccUrl: new URL('../vendor/iccs/', import.meta.url).href,
    },
    title: (currentFile?.name || '').replace(/\.pdf$/i, ''),
    wantPreview: true,
    isCancelled: () => cancelled,
    onEvent: handleEngineEvent,
  });
}

async function startConversion() {
  if (running || !currentFile) return;

  running = true;
  cancelled = false;
  showError('');
  els.startBtn.disabled = true;
  els.startBtn.hidden = true;
  els.cancelBtn.hidden = false;
  els.resultCard.hidden = true;
  els.progressCard.hidden = false;
  clearLog();
  progress.total = 0;
  progress.completed = 0;
  progress.assembling = false;
  progress.expectedMs = 1500;
  progress.pageStart = performance.now();
  progress.pageFloor = 0;
  setBar(0);
  setStage('准备中…');
  els.statPages.textContent = '—';
  els.statDpi.textContent = '—';
  els.statEta.textContent = '估算中…';
  startTicking();

  const stopTimer = startElapsedTimer();
  const options = readOptions();
  let file = currentFile;

  try {
    const worker = await getWorker();
    activeEngine = worker ? 'worker' : 'main';
    fallbackReason = forcedEngine === 'main' ? 'forced' : 'unsupported';
    setEngineNote();

    if (worker) logLine('使用后台 Worker 渲染');
    else logLine('使用主线程渲染');

    let bytes = new Uint8Array(await file.arrayBuffer());
    let result;
    let workerError = null;

    if (worker) {
      try {
        result = await runWithWorker(worker, bytes, options);
      } catch (error) {
        workerError = error;
        if (error.completedAnyPage) throw error;
        // 后台线程在第一页就失败 —— 换主线程再试一次（对用户无感）。
        logLine(`后台线程失败（${error.message}），改用主线程重试…`, 'warn');
        workerPromise = Promise.resolve(null);
        activeEngine = 'main';
        fallbackReason = 'workerError';
        setEngineNote();
        bytes = null;
      }
    }

    if (!result) {
      if (!bytes) bytes = new Uint8Array(await file.arrayBuffer());
      result = await runOnMainThread(bytes, options);
    }

    if (result.cancelled || cancelled) {
      setStage('已取消');
      logLine('已取消', 'warn');
      return;
    }

    progress.completed = progress.total;
    progress.assembling = false;
    setBar(1);
    setStage('完成');
    if (result.warnings?.length) result.warnings.forEach((w) => logLine(w, 'warn'));

    const blob = new Blob([result.bytes], { type: 'application/pdf' });
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);

    const name = outputFileName();
    els.downloadLink.href = objectUrl;
    els.downloadLink.download = name;

    const pageCount = result.pages?.length || progress.total;
    const dpiList = [...new Set((result.pages || []).map((p) => Math.round(p.dpi)))];
    const dpiText = dpiList.length ? `${dpiList.join('/')} dpi` : `${options.dpi} dpi`;
    els.resultSummary.textContent =
      `${name} · ${pageCount} 页 · ${formatBytes(blob.size)} · ${dpiText} · 用时 ${formatDuration(result.elapsedMs)}`;

    await flushPreviews(); // 结果面板出现时缩略图已经画好
    els.resultCard.hidden = false;
    logLine(`完成：${name}（${formatBytes(blob.size)}）`, 'done');

    // 顺手触发一次下载，用户不用再找按钮。
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* 某些浏览器会拦截自动下载，结果面板里的按钮依然可用 */
    }
  } catch (error) {
    const message = error?.message || String(error);
    showError(`转换失败：${message}`);
    setStage('失败');
    logLine(`失败：${message}`, 'warn');
    if (error?.workerStack) console.error(error.workerStack);
  } finally {
    stopTicking();
    stopTimer();
    running = false;
    els.startBtn.hidden = false;
    els.cancelBtn.hidden = true;
    updateStartState();
  }
}

function cancelConversion() {
  if (!running) return;
  cancelled = true;
  setStage('正在取消…');
  if (activeEngine === 'worker') {
    void getWorker().then((worker) => worker?.postMessage({ cmd: 'cancel' }));
  }
  abortCurrentRender();
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.[0]) acceptFile(els.fileInput.files[0]);
});

/* 拖放：整个页面都是落点，不用非得对准那个虚线框。
   用 dragenter/dragleave 计数判断指针是否还在页面里 —— 在两个子元素之间移动时
   两边会各发一次 enter/leave，只看布尔值会让提示闪烁。 */
let dragDepth = 0;

function isFileDrag(event) {
  const types = event.dataTransfer?.types;
  return !!types && [...types].includes('Files');
}

function setDragging(on) {
  document.documentElement.classList.toggle('dragging', on);
  els.dropzone.classList.toggle('drag', on);
}

window.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  setDragging(true);
});

window.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault(); // 不拦截的话浏览器会直接把文件打开，页面就跳走了
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  setDragging(true);
});

window.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDragging(false);
});

window.addEventListener('dragend', () => {
  dragDepth = 0;
  setDragging(false);
});

window.addEventListener('drop', (event) => {
  dragDepth = 0;
  setDragging(false);
  if (!isFileDrag(event)) return; // 拖的是文字之类，交给浏览器默认行为
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  acceptFile(files.find(isPdfFile) || files[0]);
});

document.addEventListener('paste', (event) => {
  const file = [...(event.clipboardData?.files || [])][0];
  if (file) {
    event.preventDefault();
    acceptFile(file);
  }
});

els.clearFileBtn.addEventListener('click', clearFile);
els.startBtn.addEventListener('click', () => void startConversion());
els.cancelBtn.addEventListener('click', cancelConversion);

els.againBtn.addEventListener('click', () => {
  clearFile();
  els.fileInput.click();
});

els.dpi.addEventListener('change', () => {
  els.customDpiField.hidden = els.dpi.value !== 'custom';
  saveSettings();
});

els.quality.addEventListener('input', () => {
  els.qualityOut.textContent = `${Math.round(Number(els.quality.value) * 100)}%`;
  saveSettings();
});

for (const el of [els.format, els.customDpi]) {
  el.addEventListener('change', () => {
    saveSettings();
    updateFormatUi();
  });
}

els.pageRange.addEventListener('input', () => {
  const ok = isRangeSyntaxValid(els.pageRange.value);
  els.rangeHelp.textContent = ok
    ? (els.rangeHelp.dataset.pages || '支持 1-3,5,8- 这样的写法。')
    : '页码写法有误，例如可写：1-3,5,8-';
  updateStartState();
});

function updateFormatUi() {
  const isPng = els.format.value === 'png';
  els.qualityField.hidden = isPng; // PNG 用不到质量参数，直接藏起来，别让人误以为要调
  els.quality.disabled = isPng;
  els.formatHelp.textContent = isPng
    ? 'PNG 无损，单页文件可能几十 MB，适合需要绝对保真的场景。'
    : 'JPEG 是有损压缩，扫描件/文字推荐质量 92% 以上。';
}

window.addEventListener('beforeunload', (event) => {
  if (running) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* 初始化 */
loadSettings();
els.qualityOut.textContent = `${Math.round(Number(els.quality.value) * 100)}%`;
els.customDpiField.hidden = els.dpi.value !== 'custom';
updateFormatUi();
updateStartState();
setBar(0);
// 给 index.html 里的能力检测脚本一个「页面已经跑起来」的信号
window.__appReady = true;
