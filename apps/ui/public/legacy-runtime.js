/* ============================================================
 * legacy-runtime.js —— 最低运行环境垫片（**WebView 92 基线**）
 *
 * 基线实据：真机 Redmi K20 / MIUI 12.5（Android 11）WebView = 92.0.4515.131。
 * 模拟器与桌面 Chromium 版本更新，长期掩盖了此缺口（M3 真机验证 §1.1 才暴露）。
 *
 * 为什么需要它：esbuild（含 vite 的 build.target）**只降语法、不补运行时 API**。
 * 产物里出现基线以上的 API 时，旧 WebView 报「xxx is not a function」——
 * 装配期静默炸掉（实测：cordis 打包进来的 Object.hasOwn → 真机白屏）。
 *
 * 三处同一份基线，改基线须三处同步：
 *   ① 本文件（运行时垫片；补上一个 API = 从守门表放行）
 *   ② vite.config.ts build.target（语法降级）
 *   ③ scripts/check-webview-baseline.mjs（构建期守门：在位于否 + 顺序 +
 *      产物超基线 API 命中即 fail。**它按本文件里的 feature-detect 判定覆盖**
 *      ——故每个垫片都必须以 `typeof <全名> !== 'function'` 起头，勿改写成别名。）
 *
 * 加载约束（改了就不生效，守门脚本会拦）：必须是 classic script（无 type=module）
 * ——classic 先于任何 module 求值；且 CSP `script-src 'self'` 只放行外部脚本，
 * 不得内联。
 *
 * 写法刻意保持 ES5：本文件的唯一职责就是在**旧**引擎上跑起来。
 * ============================================================ */
(function () {
  'use strict';

  // ---- Object.hasOwn（Chrome 93）：cordis 装配路径直接调用 ----
  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      value: function hasOwn(target, key) {
        if (target === null || target === undefined) {
          throw new TypeError('Cannot convert undefined or null to object');
        }
        return Object.prototype.hasOwnProperty.call(Object(target), key);
      },
      writable: true,
      configurable: true,
    });
  }

  // ---- Array.prototype.findLast / findLastIndex（Chrome 97）：编辑器族（tiptap）用 ----
  if (typeof Array.prototype.findLast !== 'function') {
    Object.defineProperty(Array.prototype, 'findLast', {
      value: function findLast(predicate, thisArg) {
        if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
      writable: true,
      configurable: true,
    });
  }

  if (typeof Array.prototype.findLastIndex !== 'function') {
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      value: function findLastIndex(predicate, thisArg) {
        if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
      writable: true,
      configurable: true,
    });
  }

  // ---- 拷贝式数组方法三件（Chrome 110）：Vue 运行时内部用 ----
  if (typeof Array.prototype.toReversed !== 'function') {
    Object.defineProperty(Array.prototype, 'toReversed', {
      value: function toReversed() {
        var out = this.slice();
        out.reverse();
        return out;
      },
      writable: true,
      configurable: true,
    });
  }

  if (typeof Array.prototype.toSorted !== 'function') {
    Object.defineProperty(Array.prototype, 'toSorted', {
      value: function toSorted(compareFn) {
        if (compareFn !== undefined && typeof compareFn !== 'function') {
          throw new TypeError('The comparison function must be either a function or undefined');
        }
        var out = this.slice();
        out.sort(compareFn);
        return out;
      },
      writable: true,
      configurable: true,
    });
  }

  if (typeof Array.prototype.toSpliced !== 'function') {
    Object.defineProperty(Array.prototype, 'toSpliced', {
      value: function toSpliced() {
        // 语义对齐：slice 后按原参数 splice（start 缺省 = 0、deleteCount 缺省 = 到末尾，
        // 与 splice 自身的参数缺省规则一致）
        var out = this.slice();
        Array.prototype.splice.apply(out, arguments);
        return out;
      },
      writable: true,
      configurable: true,
    });
  }

  // ---- AbortSignal.timeout（Chrome 103）：桌面壳存储桥探活用 ----
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    Object.defineProperty(AbortSignal, 'timeout', {
      value: function timeout(ms) {
        if (typeof ms !== 'number' || ms !== ms || ms < 0) {
          throw new TypeError('timeout must be a non-negative number');
        }
        var controller = new AbortController();
        setTimeout(function () {
          controller.abort(new DOMException('signal timed out', 'TimeoutError'));
        }, ms);
        return controller.signal;
      },
      writable: true,
      configurable: true,
    });
  }
})();
