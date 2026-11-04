# PDF 转图片 PDF

把 PDF 的每一页按 **600 dpi（或更高）** 渲染成高清图片，再重新组装成新的 PDF —— 相当于
「逐页导出高清图 → 再用图片合成 PDF」。

整个过程 **100% 在你的浏览器里完成**：文件不会被上传到任何服务器，页面也不需要后端。
纯静态文件，可以直接丢到 GitHub Pages 上。

## 功能

- **本地处理**：没有任何网络上传，断网也能用。
- **高分辨率**：150 / 300 / 600 / 900 / 1200 dpi，或自定义（50–2400）。
- **页面尺寸不变**：输出 PDF 每页的点值尺寸与原文件一致，改变的只是页面内图片的像素密度。
- **无损或高压缩**：PNG（无损）或 JPEG（默认质量 92%）；JPEG 直接原样嵌入，不会二次压缩。
- **进度可见**：总进度条、当前页、当前 DPI、已用时间、预计剩余、逐页日志、当前页缩略图。
- **可取消**：中途取消不会留下半个文件。
- **后台线程**：默认在 Web Worker 里渲染，处理大图时界面依然流畅；不支持时自动退回主线程。
- **页码范围**：支持 `1-3,5,8-` 这样的写法，只转换需要的部分。
- **超限保护**：超出浏览器画布上限时自动降级到该页可用的最高 DPI，并在日志里说明。
- **记住设置**：DPI、格式、质量存在浏览器本地（localStorage），下次打开还是上次的选择。

## 使用

打开站点首页（或本地 `npm run serve` 后访问）：

1. 选择或拖入 PDF（也支持 Ctrl/⌘ + V 粘贴文件）。
2. 设置分辨率、图片格式、JPEG 质量、页码范围。
3. 点「开始转换」，等进度走完，结果会自动下载，也可以点结果面板里的按钮重新下载。

## 部署到 GitHub Pages

仓库里已经带了 `.nojekyll`，没有构建步骤，`index.html` 就在根目录。

**方式一：分支部署（最简单）**

1. 把仓库推到 GitHub。
2. Settings → Pages → Source 选 `Deploy from a branch`，分支选 `main`，目录选 `/ (root)`。
3. 等一分钟，访问 `https://<用户名>.github.io/<仓库名>/`。

**方式二：GitHub Actions**

仓库里带了 `.github/workflows/pages.yml`，推送到 `main` 就会自动发布；
需要在 Settings → Pages → Source 里选 `GitHub Actions`。

所有引用都是相对路径（`./assets/...`、`../vendor/...`），放在子路径下也能正常工作。
`vendor/` 里的文件名都用 `.js` 而不是 `.mjs`，就是为了避免某些静态托管对 `.mjs`
给出错误的 MIME 类型（浏览器会因此拒绝加载模块）。

## 工作原理

```
PDF 文件
  └─ pdf.js：把每页渲染到画布（600 dpi 的 A4 约 4960×7016 像素）
       └─ 画布编码成 JPEG / PNG
            └─ pdf-lib：把图片嵌入新 PDF，页面尺寸沿用原页尺寸
                 └─ 下载（Blob URL）
```

- 逐页处理，一页处理完就释放画布，内存占用大致是「输出文件大小 + 一页的像素」。
- 后台线程里，pdf.worker.js 与显示代码同线程运行（pdf.js 发现 `globalThis.pdfjsWorker`
  存在时就地使用它），因此不需要嵌套 Worker，兼容性更好。
- 主线程模式下 pdf.js 仍然会按 `GlobalWorkerOptions.workerSrc` 自己起一个模块 Worker，那是第三个
  realm；`assets/pdf-worker.js` 就是为它准备的入口——先把 `assets/compat.js` 装进去，再加载真正的
  pdf.worker.js，所以补丁在哪个线程里都生效。
- Worker 里没有 DOM，所以额外提供了基于 `OffscreenCanvas` 的 `CanvasFactory`、空实现的
  `FilterFactory`，并用 `disableFontFace`（按字形轮廓绘制，与 Node 环境一致）。

## 目录结构

```
index.html                 页面
assets/app.js              界面、进度、引擎选择、下载
assets/rasterize.js        共享引擎：渲染 + 编码 + 组装（Worker / 主线程都能跑）
assets/render-worker.js    后台线程入口
assets/compat.js           新 ES 方法的补丁（页面和每个 Worker realm 各装一次）
assets/pdf-worker.js       pdf.js 自起 Worker 时用的入口：先装补丁，再加载 pdf.worker.js
assets/style.css           样式
vendor/                    运行时依赖（从 node_modules 复制而来）
  pdf.js  pdf.worker.js    pdf.js 6.x（渲染）
  pdf-lib.js               pdf-lib 1.17（组装 PDF）
  cmaps/ standard_fonts/ wasm/ iccs/   pdf.js 的资源文件
tools/serve.mjs            本地预览用的静态服务器（Pages 不需要）
tools/vendor.mjs           刷新 vendor/ 的脚本
```

`node_modules` 只在开发/测试时需要，部署时不必上传。运行页面只需要 `index.html`、`assets/`、
`vendor/` 三部分。

## 开发

```bash
npm install                 # 只为拉取 pdfjs-dist / pdf-lib / puppeteer
npm run vendor              # 从 node_modules 刷新 vendor/
npm run serve               # http://127.0.0.1:8080/
```

本地预览务必用 HTTP 打开，不要用 `file://`（模块脚本会被 CORS 挡住）。

调试参数：

- `?engine=main` / `?engine=worker` 强制使用主线程或后台线程。
- `?maxSide=` / `?maxPixels=` 覆盖画布上限（默认 16384 px / 1.5 亿像素），用来测试降级逻辑。

测试（需要 Chrome）：

```bash
npm test                                     # 端到端：12 个用例（7 转换 + 取消 + 界面/拖放/兼容性）
tmp/.venv/bin/python -I tmp/test/verify_pdfs.py tmp/test/out/manifest.json
```

`npm test` 用 Puppeteer 驱动真实浏览器，覆盖 Worker / 主线程、JPEG / PNG、页码范围、
旋转页、画布降级、多页与取消，以及界面状态（自定义 DPI / JPEG 质量只在该出现时出现、「移除」真的移除、选项记忆）、整页任意位置拖放、旧版 Promise 环境、浏览器不支持时的提示，以及「浏览器把 pdf.js 需要的新 ES 方法全缺了」时还能不能照常转换；`verify_pdfs.py` 再用 PyMuPDF 检查输出的页数、页面尺寸、
图片像素与编码方式，并把输出页与原文件做像素级对比：同分辨率下矢量页几乎一致（JPEG 平均误差 < 9），
再降到 96 dpi 比一次内容（排除空白页、串页、拉伸），说明是真实还原。

## 已知限制

- **不支持加密 PDF**：需要密码的文件会直接报错。
- **画布上限**：单页像素受浏览器限制（本工具默认 16384 px 单边、1.5 亿像素，超出自动降级）。
  A4 在 1200 dpi 时约 9921×14032 像素，已经接近部分浏览器的上限；页数多时建议 600 dpi。
- **文件会变大**：600 dpi 的 A4 文字页 JPEG 通常 1–4 MB，PNG 可能几十 MB，属于正常现象。
- **浏览器要求**：`structuredClone`、`FileReader`、画布 `toBlob`、模块 Web Worker 这些基础能力由启动
  检测把关，缺了就直接提示并收起交互区域，而不是等到转换到一半才莫名失败。pdf.js 6 内部还用到一批
  更新的 ES 方法（`Uint8Array` 的 hex / base64、`Map#getOrInsertComputed`、`Math.sumPrecise`、
  `Set#intersection`、`URL.parse`、`AbortSignal.any` 等，最晚的要 Chrome 140 才有），这些由站点自带的
  `assets/compat.js` 补齐，所以 **Chrome / Edge 114+** 以及同代的 Safari / Firefox 都能用。
  实测通过：Chromium 134（134.0.6998.165）与 156。
- 输出 PDF 里的文字不再可选、可搜索（这是「转成图片」的代价）。

## 第三方组件

- [pdf.js](https://github.com/mozilla/pdf.js) — Apache-2.0，见 `vendor/LICENSE.pdfjs`
- [pdf-lib](https://github.com/Hopding/pdf-lib) — MIT，见 `vendor/LICENSE.pdf-lib.md`
