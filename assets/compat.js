/**
 * compat.js —— 给老一点的浏览器补上新版才有的方法。
 *
 * pdf.js 6.x 直接用了一批很新的 ES 内置方法，而且散落在解析、渲染、字体、
 * 编辑器等各处，缺一个就会在中途抛出难懂的类型错误。Chromium 134 上先是
 * 「a.toHex is not a function」，补完之后又冒出「getOrInsertComputed is not
 * a function」。这些方法都能用几行代码等价实现，所以这里一次性补齐：
 *
 *   Uint8Array.prototype.toHex / toBase64 / setFromHex / setFromBase64
 *   Uint8Array.fromHex / fromBase64                  (Chrome 140)
 *   Map / WeakMap.prototype.getOrInsert(Computed)    (Chrome 140)
 *   Math.sumPrecise                                  (Chrome 138)
 *   Set.prototype.union / intersection / difference /
 *     symmetricDifference / isSubsetOf / isSupersetOf /
 *     isDisjointFrom                                 (Chrome 122)
 *   URL.parse                                        (Chrome 126)
 *   Response.prototype.bytes                         (Chrome 121)
 *   Blob.prototype.bytes                             (Chrome 118)
 *   AbortSignal.any                                  (Chrome 116)
 *   Promise.withResolvers / Promise.try              (Chrome 119 / 128)
 *
 * 页面和 Worker 各装一次，因为两个 realm 的全局对象是分开的。pdf.js 还会
 * 从 GlobalWorkerOptions.workerSrc 自己另起一个模块 Worker（又一个 realm），
 * 所以 assets/pdf-worker.js 会先把本文件 import 进去，再加载
 * vendor/pdf.worker.js；页面里则是 assets/app.js 的第一条 import。
 */

const HEX_CHARS = '0123456789abcdef';
const B64_STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WHITESPACE = /[\t\n\f\r ]/g;

function assertBytes(value, what) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${what} called on a non-Uint8Array`);
  }
  return value;
}

function hexDigit(code) {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 70) return code - 55; // A-F
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

function isUrlAlphabet(options) {
  return !!options && options.alphabet === 'base64url';
}

function toHex() {
  const bytes = assertBytes(this, 'toHex');
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_CHARS[bytes[i] >> 4] + HEX_CHARS[bytes[i] & 15];
  }
  return out;
}

/** 与规范一致：奇数长度或含非法字符都抛 SyntaxError。 */
function fromHex(string) {
  const source = String(string);
  if (source.length % 2 !== 0) throw new SyntaxError('hex string must have an even length');
  const out = new Uint8Array(source.length >> 1);
  for (let i = 0, j = 0; i < source.length; i += 2, j++) {
    const high = hexDigit(source.charCodeAt(i));
    const low = hexDigit(source.charCodeAt(i + 1));
    if (high < 0 || low < 0) throw new SyntaxError('invalid character in hex string');
    out[j] = (high << 4) | low;
  }
  return out;
}

function toBase64(options) {
  const bytes = assertBytes(this, 'toBase64');
  const alphabet = isUrlAlphabet(options) ? B64_URL : B64_STANDARD;
  const omitPadding = !!(options && options.omitPadding);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2] + alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) {
      if (!omitPadding) out += '==';
      break;
    }
    out += alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) {
      if (!omitPadding) out += '=';
      break;
    }
    out += alphabet[b2 & 63];
  }
  return out;
}

function decodeBase64(string, options) {
  const alphabet = isUrlAlphabet(options) ? B64_URL : B64_STANDARD;
  const source = String(string).replace(WHITESPACE, '');
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;

  const out = new Uint8Array(Math.ceil((source.length * 3) / 4));
  let written = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === 61) break; // '=' 之后都是填充
    const value = code < 128 ? table[code] : -1;
    if (value < 0) throw new SyntaxError('invalid character in base64 string');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, written);
}

function fromBase64(string, options) {
  return decodeBase64(string, options);
}

function setFromBase64(string, options) {
  const bytes = assertBytes(this, 'setFromBase64');
  const decoded = decodeBase64(string, options);
  const written = Math.min(decoded.length, bytes.length);
  bytes.set(decoded.subarray(0, written));
  return { read: String(string).length, written };
}

function setFromHex(string) {
  const bytes = assertBytes(this, 'setFromHex');
  const decoded = fromHex(string);
  const written = Math.min(decoded.length, bytes.length);
  bytes.set(decoded.subarray(0, written));
  return { read: String(string).length, written };
}

/* ── Map / WeakMap 的 getOrInsert 系列（Chrome 140）────────────────────────
 * pdf.js 用得很重：缓存、页码映射、对象池都靠 `map.getOrInsertComputed(k, fn)`
 * 一步拿到「有就取、没有就算出来存进去」。回调只接受 key 一个参数。
 */
function getOrInsert(key, value) {
  if (this.has(key)) return this.get(key);
  this.set(key, value);
  return value;
}

function getOrInsertComputed(key, callback) {
  if (this.has(key)) return this.get(key);
  const value = callback(key);
  this.set(key, value);
  return value;
}

/* ── Math.sumPrecise（Chrome 138）─────────────────────────────────────────
 * 规范要求「正确舍入」的求和。这里用 Neumaier 补偿求和：pdf.js 传进来的都是
 * 整数长度，这种情形下与规范完全一致。元素不是数字时按规范抛 TypeError。
 */
function sumPrecise(items) {
  if (items == null) throw new TypeError('Math.sumPrecise requires an iterable');
  let sum = 0;
  let compensation = 0;
  for (const item of items) {
    if (typeof item !== 'number') throw new TypeError('Math.sumPrecise: not a number');
    const t = sum + item;
    compensation += Math.abs(sum) >= Math.abs(item) ? sum - t + item : item - t + sum;
    sum = t;
  }
  return sum + compensation;
}

/* ── Set 的新方法（Chrome 122）────────────────────────────────────────────
 * 参数按规范叫 set-like：只要有 has/keys/size 就行，这里简化成「能迭代」。
 */
function toSetLike(other) {
  return other instanceof Set ? other : new Set(other);
}

function setUnion(other) {
  const result = new Set(this);
  for (const value of other) result.add(value);
  return result;
}

function setIntersection(other) {
  const lookup = toSetLike(other);
  const result = new Set();
  for (const value of this) if (lookup.has(value)) result.add(value);
  return result;
}

function setDifference(other) {
  const lookup = toSetLike(other);
  const result = new Set();
  for (const value of this) if (!lookup.has(value)) result.add(value);
  return result;
}

function setSymmetricDifference(other) {
  const lookup = toSetLike(other);
  const result = new Set();
  for (const value of this) if (!lookup.has(value)) result.add(value);
  for (const value of lookup) if (!this.has(value)) result.add(value);
  return result;
}

function setIsSubsetOf(other) {
  const lookup = toSetLike(other);
  for (const value of this) if (!lookup.has(value)) return false;
  return true;
}

function setIsSupersetOf(other) {
  for (const value of other) if (!this.has(value)) return false;
  return true;
}

function setIsDisjointFrom(other) {
  const lookup = toSetLike(other);
  for (const value of this) if (lookup.has(value)) return false;
  return true;
}

/* ── URL.parse（Chrome 126）──────────────────────────────────────────────
 * 相对 new URL() 的区别只是「解析失败返回 null 而不是抛异常」，pdf.js 靠这个
 * 判断链接是否安全可点。
 */
function urlParse(url, base) {
  try {
    return base === undefined ? new URL(url) : new URL(url, base);
  } catch {
    return null;
  }
}

/* ── AbortSignal.any（Chrome 116）────────────────────────────────────────
 * 任一信号中止，返回的信号就中止。pdf.js 用它把「页面的」和「自己的」
 * 两个取消信号合成一个。这里用 AbortController 转接；源信号不会回收，
 * 但每个信号上只挂一个 once 监听，量级可以忽略。
 */
function abortSignalAny(signals) {
  const controller = new AbortController();
  const abort = (signal) => controller.abort(signal.reason);
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

/* ── Promise 的两个新方法（Chrome 119 / 128）──────────────────────────────
 * index.html 里已经给页面补过一份，这里再补一次是为了 Worker realm。
 */
function promiseWithResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function promiseTry(callback, ...args) {
  return new Promise((resolve) => resolve(callback(...args)));
}

const bytesFromBlob = async function bytes() {
  return new Uint8Array(await this.arrayBuffer());
};

/** 装上缺的那些方法，返回这次真正补了哪几个（方便排查用）。 */
export function installCompat() {
  const installed = new Set();
  const add = (target, name, value) => {
    if (typeof target[name] === 'function') return;
    Object.defineProperty(target, name, { value, writable: true, configurable: true });
    installed.add(name);
  };

  if (typeof Uint8Array === 'function') {
    const proto = Uint8Array.prototype;
    add(proto, 'toHex', toHex);
    add(Uint8Array, 'fromHex', fromHex);
    add(proto, 'toBase64', toBase64);
    add(Uint8Array, 'fromBase64', fromBase64);
    add(proto, 'setFromBase64', setFromBase64);
    add(proto, 'setFromHex', setFromHex);
  }

  for (const Ctor of [typeof Map === 'function' ? Map : null, typeof WeakMap === 'function' ? WeakMap : null]) {
    if (!Ctor) continue;
    add(Ctor.prototype, 'getOrInsert', getOrInsert);
    add(Ctor.prototype, 'getOrInsertComputed', getOrInsertComputed);
  }

  if (typeof Math === 'object' && Math !== null) add(Math, 'sumPrecise', sumPrecise);

  if (typeof Set === 'function') {
    const proto = Set.prototype;
    add(proto, 'union', setUnion);
    add(proto, 'intersection', setIntersection);
    add(proto, 'difference', setDifference);
    add(proto, 'symmetricDifference', setSymmetricDifference);
    add(proto, 'isSubsetOf', setIsSubsetOf);
    add(proto, 'isSupersetOf', setIsSupersetOf);
    add(proto, 'isDisjointFrom', setIsDisjointFrom);
  }

  // Blob#bytes()（Chrome 118）与 Response#bytes()（Chrome 121）都是
  // 「arrayBuffer() 之后再包一层 Uint8Array」，pdf.js 读图片和签名时用得到。
  if (typeof Blob === 'function' && typeof Blob.prototype.arrayBuffer === 'function') {
    add(Blob.prototype, 'bytes', bytesFromBlob);
  }
  if (typeof Response === 'function' && typeof Response.prototype.arrayBuffer === 'function') {
    add(Response.prototype, 'bytes', bytesFromBlob);
  }

  if (typeof Promise === 'function') {
    add(Promise, 'withResolvers', promiseWithResolvers);
    add(Promise, 'try', promiseTry);
  }

  if (typeof URL === 'function') add(URL, 'parse', urlParse);
  if (typeof AbortController === 'function' && typeof AbortSignal === 'function') {
    add(AbortSignal, 'any', abortSignalAny);
  }

  const list = [...installed];
  try {
    globalThis.__compatInstalled = list;
  } catch {
    /* 只用于排查，失败无所谓 */
  }
  return list;
}

export const compatInstalled = installCompat();
