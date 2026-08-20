// src/vendor/hmr/src/index.ts
import { Service } from "@agentchat/cordis";
import "@agentchat/cordis-loader";
import { watch } from "chokidar";
import { dirname, relative, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";

// src/vendor/hmr/src/error.ts
import "@agentchat/cordis";
import { codeFrameColumns } from "@babel/code-frame";
import { readFileSync } from "node:fs";
function isBuildFailure(e) {
  return Array.isArray(e?.errors) && e.errors.every((error) => error.text);
}
function handleError(ctx, e) {
  if (!isBuildFailure(e)) {
    ctx.logger.warn(e);
    return;
  }
  for (const error of e.errors) {
    if (!error.location) {
      ctx.logger.warn(error.text);
      continue;
    }
    try {
      const { file, line, column } = error.location;
      const source = readFileSync(file, "utf8");
      const formatted = codeFrameColumns(source, {
        start: { line, column }
      }, {
        highlightCode: true,
        message: error.text
      });
      ctx.logger.warn(`File: ${file}:${line}:${column}
` + formatted);
    } catch (e2) {
      ctx.logger.warn(e2);
    }
  }
}

// src/vendor/hmr/src/index.ts
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import picomatch from "picomatch";
import z from "@agentchat/schemastery";
async function loadDependencies(job, ignored = /* @__PURE__ */ new Set()) {
  const dependencies = /* @__PURE__ */ new Set();
  async function traverse(job2) {
    if (ignored.has(job2.url) || dependencies.has(job2.url)) return;
    if (job2.url.startsWith("node:") || job2.url.includes("/node_modules/")) return;
    dependencies.add(job2.url);
    const children = await job2.linked;
    await Promise.all(Array.prototype.map.call(children, traverse));
  }
  await traverse(job);
  return dependencies;
}
async function findWatchRoot(filename) {
  let root = dirname(filename);
  let depth = 0;
  while (true) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error(`config watch parent is not a directory: ${root}`);
      const canonicalRoot = await realpath(root);
      return {
        filename: resolve(canonicalRoot, relative(root, filename)),
        root: canonicalRoot,
        depth
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(root);
      if (parent === root) throw error;
      root = parent;
      depth += 1;
    }
  }
}
var Hmr = class extends Service {
  constructor(ctx, config) {
    super(ctx, "hmr");
    this.config = config;
    if (!this.ctx.loader.internal) {
      throw new Error("--expose-internals is required for HMR service");
    }
    this.internal = this.ctx.loader.internal;
    this.baseDir = fileURLToPath(new URL(config.base || ".", ctx.baseUrl));
    this.watermark = Date.now() - Math.floor(process.uptime() * 1e3);
  }
  config;
  static inject = ["loader", "timer"];
  baseDir;
  internal;
  watcher;
  configs = /* @__PURE__ */ new Map();
  configRefreshes = /* @__PURE__ */ new WeakMap();
  refreshTasks = /* @__PURE__ */ new Set();
  /**
   * Changes from externals will always trigger a full reload.
   * Externals are the dependency tree of the CLI worker entry point.
   */
  externals;
  /**
   * Files that should be reloaded (accepted changes).
   * Includes all stashed files and their dependents.
   */
  accepted;
  /**
   * Files that should NOT be reloaded.
   * Includes externals and files whose dependents are all declined.
   */
  declined;
  /** Stashed file changes waiting to be processed */
  stashed = /* @__PURE__ */ new Set();
  /** True while an active reloadFiles() transaction is in flight */
  reloading = false;
  /**
   * Reload watermark (epoch ms): files with mtime >= this are considered
   * changed. Initialized to process start; advanced to now after every
   * successful partial reload.
   * @agentchat vendored addition — watermark discovery for reload_modules.
   */
  watermark;
  /**
   * Watch one exact config path outside the configured module roots.
   * @param filename - Config path, resolved against the HMR base directory.
   * @param refresh - Refresh callback run serially on add, change, or unlink.
   * @returns an asynchronous disposer once the exact watch is ready.
   * @throws when HMR is inactive, the path is already registered, or watcher startup fails.
   */
  async registerConfig(filename, refresh) {
    if (!this.watcher) throw new Error("HMR is not active");
    filename = resolve(this.baseDir, filename);
    const target = await findWatchRoot(filename);
    const watchFilename = target.filename;
    if (this.configs.has(watchFilename)) throw new Error(`config path already registered: ${filename}`);
    const { root, depth } = target;
    const watcher = watch(root, {
      ...this.config,
      cwd: void 0,
      depth,
      ignored: void 0,
      ignoreInitial: false
    });
    const registration = { watcher };
    this.configs.set(watchFilename, registration);
    const onChange = (path) => {
      const observed = resolve(path);
      if (observed !== filename && observed !== watchFilename) return;
      this.refreshConfig(registration, filename, refresh);
    };
    watcher.on("add", onChange);
    watcher.on("change", onChange);
    watcher.on("unlink", onChange);
    const ready = Promise.withResolvers();
    let readyState = "pending";
    watcher.once("ready", () => {
      readyState = "resolved";
      ready.resolve();
    });
    watcher.on("error", (error) => {
      if (readyState === "pending") {
        readyState = "rejected";
        ready.reject(error);
      } else {
        this.ctx.logger.warn(error);
      }
    });
    try {
      await ready.promise;
      return this.ctx.effect(() => async () => {
        if (this.configs.get(watchFilename) === registration) this.configs.delete(watchFilename);
        await watcher.close();
        await this.configRefreshes.get(registration)?.running;
      }, "hmr.registerConfig()");
    } catch (error) {
      this.configs.delete(watchFilename);
      await watcher.close();
      throw error;
    }
  }
  /**
   * Resolve a module specifier to a URL, compatible with Node 22-24.
   */
  async _resolve(specifier, parentURL, attrs) {
    switch (this.internal.version) {
      case "v1":
        return await this.internal.resolve(specifier, parentURL, attrs);
      case "v2":
        return this.internal.resolveSync(parentURL, { specifier, attributes: attrs });
    }
  }
  async *[Service.init]() {
    yield async () => {
      await this.watcher?.close();
      await Promise.allSettled([...this.configs.values()].map((registration) => registration.watcher.close()));
      this.configs.clear();
      await Promise.allSettled([...this.refreshTasks]);
    };
    const { loader } = this.ctx;
    const { root, ignored } = this.config;
    if (!this.config.base) {
      this.ctx.logger.info("watching %o", root);
    } else {
      this.ctx.logger.info("watching %o in %s", root, this.baseDir);
    }
    const match = picomatch(ignored);
    const watchBaseDir = await realpath(this.baseDir);
    const mainUrl = pathToFileURL(resolve(process.argv[1])).href;
    const mainJob = this.internal.loadCache.get(mainUrl);
    if (mainJob) {
      this.externals = await loadDependencies(mainJob);
    } else {
      this.externals = /* @__PURE__ */ new Set();
    }
    this.watcher = watch(root, {
      ...this.config,
      cwd: watchBaseDir,
      ignored: (path) => match(relative(watchBaseDir, path)),
      // The initial scan re-announces files the boot just consumed: an `add`
      // for a config file refreshes an include whose initial apply may still
      // be in flight, and a failing apply then rolls this plugin back while
      // the scan-triggered refresh waits on that apply — a teardown deadlock
      // that strands boot without a diagnostic. Only events after the scan
      // matter here; `registerConfig` keeps its own initial scan because a
      // user patch layer present at registration must apply once.
      ignoreInitial: true
    });
    const partialReload = this.ctx.debounce(() => this.partialReload(), this.config.debounce);
    const onChange = (kind, path) => {
      this.ctx.logger.debug("%s detected at %C", kind, path);
      const filename = resolve(watchBaseDir, path);
      const configuredFilename = resolve(this.baseDir, path);
      for (const entry of loader.entries()) {
        const include = entry.subtree;
        if (include?.filename !== filename && include?.filename !== configuredFilename) continue;
        this.refreshConfig(include, include.filename, () => include.refresh());
        return;
      }
      if (kind !== "change") return;
      const url = pathToFileURL(filename).href;
      if (this.externals.has(url)) return loader.exit();
      if (loader.internal.loadCache.has(url)) {
        this.stashed.add(url);
        return partialReload();
      }
      this.ctx.emit("hmr/change", url);
    };
    this.watcher.on("add", (path) => onChange("add", path));
    this.watcher.on("change", (path) => onChange("change", path));
    this.watcher.on("unlink", (path) => onChange("unlink", path));
    const ready = Promise.withResolvers();
    let readyState = root.length === 0 ? "resolved" : "pending";
    if (root.length === 0) {
      ready.resolve();
    } else {
      this.watcher.once("ready", () => {
        readyState = "resolved";
        ready.resolve();
      });
    }
    this.watcher.on("error", (error) => {
      if (readyState === "pending") {
        readyState = "rejected";
        ready.reject(error);
      } else {
        this.ctx.logger.warn(error);
      }
    });
    await ready.promise;
  }
  refreshConfig(key, filename, refresh) {
    const state = this.configRefreshes.get(key) ?? { dirty: false };
    this.configRefreshes.set(key, state);
    state.dirty = true;
    if (state.running) return;
    const task = (async () => {
      do {
        state.dirty = false;
        try {
          await refresh();
        } catch (reason) {
          const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
          this.ctx.logger.warn("config reload at %C failed", filename);
          this.ctx.logger.warn(error);
          try {
            await this.ctx.parallel("hmr/config-update-failed", filename, error);
          } catch (rejection) {
            this.ctx.logger.warn(rejection);
          }
        }
      } while (state.dirty);
    })().finally(() => {
      state.running = void 0;
      this.refreshTasks.delete(task);
    });
    state.running = task;
    this.refreshTasks.add(task);
  }
  // hide stack trace from HMR
  getOuterStack = () => [
    // '    at HMR.partialReload (<anonymous>)',
  ];
  async getLinked(url) {
    const job = this.internal.loadCache.get(url);
    if (!job) return [];
    const linked = await job.linked;
    return Array.prototype.map.call(linked, (job2) => job2.url);
  }
  /**
   * Whether a module URL belongs to the framework externals
   * (the dependency tree of the worker entry point). Such files can never
   * be reloaded in-process and require a process restart instead.
   * @agentchat vendored addition
   */
  isExternal(url) {
    return this.externals?.has(url) ?? false;
  }
  /**
   * Whether a file URL is a currently loaded module (present in the ESM
   * loadCache). In Node 24 this covers modules imported via import(),
   * regardless of module format.
   * @agentchat vendored addition
   */
  isLoaded(url) {
    return this.internal.loadCache.has(url);
  }
  /**
   * Actively reload the given module URLs (agent-declared completion, see
   * docs/restart-design.md §2). Replaces the passive watcher path: the
   * caller decides WHEN to reload, this machine decides WHAT to reload
   * (dependency propagation, plugin entry re-import, rollback on failure).
   *
   * - externals hit → rejected with an error directing to a process restart
   *   (never loader.exit(): an explicit API must not take the process down)
   * - each call is a fresh transaction: the stash is replaced, not appended
   * - on success the watermark advances; on failure caches and plugins are
   *   rolled back and the previous tree keeps running
   * @agentchat vendored addition
   */
  async reloadFiles(urls) {
    const externals = urls.filter((url) => this.isExternal(url));
    if (externals.length) {
      const names = externals.map((url) => relative(this.baseDir, fileURLToPath(url))).join(", ");
      throw new Error(`refusing to reload framework files (${names}): externals cannot be reloaded in-process, request a process restart (system_restart) instead`);
    }
    if (this.reloading) {
      throw new Error("a module reload is already in flight");
    }
    this.reloading = true;
    this.stashed = new Set(urls);
    try {
      return await this.partialReload();
    } finally {
      this.stashed = /* @__PURE__ */ new Set();
      this.reloading = false;
    }
  }
  /**
   * Classify changed files into accepted (should reload) and declined (should not).
   *
   * A file is accepted if it's directly changed (stashed) or if any of its
   * dependents are accepted. A file is declined if all its dependents are
   * declined or if it's an external.
   */
  async analyzeChanges() {
    const pending = [];
    this.accepted = new Set(this.stashed);
    this.declined = new Set(this.externals);
    const isExcluded = (url) => url.startsWith("node:") || url.includes("/node_modules/");
    await Promise.all([...this.stashed].map(async (url) => {
      const children = await this.getLinked(url);
      for (const child of children) {
        if (this.accepted.has(child) || this.declined.has(child) || isExcluded(child)) continue;
        pending.push(child);
      }
    }));
    while (pending.length) {
      let index = 0, hasUpdate = false;
      while (index < pending.length) {
        const url = pending[index];
        const children = await this.getLinked(url);
        let isDeclined = true, isAccepted = false;
        for (const child of children) {
          if (this.declined.has(child) || isExcluded(child)) continue;
          if (this.accepted.has(child)) {
            isAccepted = true;
            break;
          } else {
            isDeclined = false;
            if (!pending.includes(child)) {
              hasUpdate = true;
              pending.push(child);
            }
          }
        }
        if (isAccepted || isDeclined) {
          hasUpdate = true;
          pending.splice(index, 1);
          if (isAccepted) {
            this.accepted.add(url);
          } else {
            this.declined.add(url);
          }
        } else {
          index++;
        }
      }
      if (!hasUpdate) break;
    }
    for (const url of pending) {
      this.declined.add(url);
    }
  }
  async partialReload() {
    await this.analyzeChanges();
    const pending = /* @__PURE__ */ new Map();
    const reloads = /* @__PURE__ */ new Map();
    const nameMap = /* @__PURE__ */ Object.create(null);
    for (const entry of this.ctx.loader.entries()) {
      (nameMap[entry.parent.tree.ctx.baseUrl] ??= /* @__PURE__ */ new Set()).add(entry.options.name);
    }
    for (const baseUrl in nameMap) {
      for (const name of nameMap[baseUrl]) {
        try {
          const { url } = await this._resolve(name, baseUrl, {});
          if (this.declined.has(url)) continue;
          const job = this.internal.loadCache.get(url);
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace());
          if (!job || !plugin) continue;
          pending.set(job, plugin);
          this.declined.add(url);
        } catch (err) {
          this.ctx.logger.warn(err);
        }
      }
    }
    for (const [job, plugin] of pending) {
      this.declined.delete(job.url);
      const dependencies = [...await loadDependencies(job, this.declined)];
      this.declined.add(job.url);
      if (!dependencies.some((dep) => this.accepted.has(dep))) continue;
      dependencies.forEach((dep) => this.accepted.add(dep));
      reloads.set(plugin, {
        filename: job.url,
        runtime: this.ctx.registry.get(plugin)
      });
    }
    const esmBackup = /* @__PURE__ */ Object.create(null);
    const cjsBackup = /* @__PURE__ */ Object.create(null);
    const require2 = createRequire(import.meta.url);
    for (const filename of this.accepted) {
      const job = Map.prototype.get.call(this.internal.loadCache, filename);
      esmBackup[filename] = job;
      Map.prototype.delete.call(this.internal.loadCache, filename);
      try {
        const filepath = fileURLToPath(filename);
        if (require2.cache[filepath]) {
          cjsBackup[filepath] = require2.cache[filepath];
          delete require2.cache[filepath];
        }
      } catch {
      }
    }
    const rollback = () => {
      for (const filename in esmBackup) {
        Map.prototype.set.call(this.internal.loadCache, filename, esmBackup[filename]);
      }
      for (const filepath in cjsBackup) {
        require2.cache[filepath] = cjsBackup[filepath];
      }
    };
    const attempts = {};
    try {
      for (const [, { filename }] of reloads) {
        attempts[filename] = this.ctx.loader.unwrapExports(await this.ctx.loader.import(filename, this.getOuterStack));
      }
    } catch (e) {
      handleError(this.ctx, e);
      rollback();
      return { ok: false, reloaded: [], error: e instanceof Error ? e.message : String(e) };
    }
    const reload = (plugin, runtime) => {
      if (!runtime) return;
      for (const oldFiber of runtime.fibers) {
        const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, this.getOuterStack);
        fiber.entry = oldFiber.entry;
        if (fiber.entry) fiber.entry.fiber = fiber;
      }
    };
    let reloadError;
    try {
      for (const [plugin, { filename, runtime }] of reloads) {
        if (!runtime) continue;
        const path = relative(this.baseDir, fileURLToPath(filename));
        try {
          this.ctx.registry.delete(plugin);
        } catch (err) {
          this.ctx.logger.warn("failed to dispose plugin at %C", path);
          this.ctx.logger.warn(err);
        }
        try {
          reload(attempts[filename], runtime);
          this.ctx.logger.info("reload plugin at %C", path);
        } catch (err) {
          this.ctx.logger.warn("failed to reload plugin at %C", path);
          this.ctx.logger.warn(err);
          throw err;
        }
      }
    } catch (err) {
      reloadError = err instanceof Error ? err.message : String(err);
      rollback();
      for (const [plugin, { filename, runtime }] of reloads) {
        if (!runtime) continue;
        try {
          this.ctx.registry.delete(attempts[filename]);
          reload(plugin, runtime);
        } catch (err2) {
          this.ctx.logger.warn(err2);
        }
      }
      return { ok: false, reloaded: [], error: reloadError };
    }
    this.ctx.emit("hmr/reload", reloads);
    this.stashed = /* @__PURE__ */ new Set();
    this.watermark = Date.now();
    return {
      ok: true,
      reloaded: [...reloads.values()].map(({ filename }) => relative(this.baseDir, fileURLToPath(filename)))
    };
  }
};
((Hmr2) => {
  Hmr2.Config = z.object({
    base: z.string(),
    root: z.array(String).role("table").default(["."]),
    ignored: z.array(String).role("table").default([
      "**/node_modules",
      "**/.*",
      "cache",
      "data"
    ]),
    debounce: z.natural().role("ms").default(100)
  });
})(Hmr || (Hmr = {}));
var index_default = Hmr;
export {
  index_default as default
};
