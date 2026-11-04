/**
 * pdf-worker.js —— 交给 pdf.js 当 workerSrc 用的入口。
 *
 * 为什么不直接把 vendor/pdf.worker.js 当 workerSrc：pdf.js 会自己
 * `new Worker(workerSrc, { type: 'module' })`，那个 realm 跟页面、跟
 * 外层 render-worker.js 是分开的，页面里打的补丁进不去。Chromium 134
 * 就是栽在这儿：解析时算文档指纹用到 `Uint8Array#toHex`（Chrome 140 才有），
 * 于是报「a.toHex is not a function」。
 *
 * 所以这里先装 compat，再加载真正的 worker 脚本（pdf.js 用 workerSrc 时
 * 就是当模块 worker 起的，import 没问题）。
 */
import './compat.js';
import '../vendor/pdf.worker.js';
