import { Context, Service, type Plugin } from '@agentchat/cordis';
import { type ChokidarOptions } from 'chokidar';
import z from '@agentchat/schemastery';
declare module '@agentchat/cordis' {
    interface Context {
        hmr: Hmr;
    }
    interface Events {
        'hmr/change'(url: string): void;
        'hmr/reload'(reloads: Map<Plugin, Reload>): void;
        /**
         * A watched config-file refresh failed.
         * @param filename - Absolute path observed by HMR.
         * @param error - Normalized refresh failure.
         * @mode parallel
         */
        'hmr/config-update-failed'(filename: string, error: Error): Promise<void> | void;
    }
}
interface Reload {
    filename: string;
    runtime?: Plugin.Runtime;
}
/**
 * Result of an active module reload (Hmr.reloadFiles).
 * @agentchat vendored addition — see docs/restart-design.md §2.
 */
export interface ModuleReloadResult {
    /** Whether the reload fully succeeded. On failure caches were restored
     *  and old plugins re-registered, so the previous tree keeps running. */
    ok: boolean;
    /** Successfully reloaded plugin entry files (readable relative paths). */
    reloaded: string[];
    /** Failure description when `ok` is false. */
    error?: string;
}
declare class Hmr extends Service {
    config: Hmr.Config;
    static inject: string[];
    baseDir: string;
    private internal;
    private watcher;
    private readonly configs;
    private readonly configRefreshes;
    private readonly refreshTasks;
    /**
     * Changes from externals will always trigger a full reload.
     * Externals are the dependency tree of the CLI worker entry point.
     */
    private externals;
    /**
     * Files that should be reloaded (accepted changes).
     * Includes all stashed files and their dependents.
     */
    private accepted;
    /**
     * Files that should NOT be reloaded.
     * Includes externals and files whose dependents are all declined.
     */
    private declined;
    /** Stashed file changes waiting to be processed */
    private stashed;
    /** True while an active reloadFiles() transaction is in flight */
    private reloading;
    /**
     * Reload watermark (epoch ms): files with mtime >= this are considered
     * changed. Initialized to process start; advanced to now after every
     * successful partial reload.
     * @agentchat vendored addition — watermark discovery for reload_modules.
     */
    watermark: number;
    constructor(ctx: Context, config: Hmr.Config);
    /**
     * Watch one exact config path outside the configured module roots.
     * @param filename - Config path, resolved against the HMR base directory.
     * @param refresh - Refresh callback run serially on add, change, or unlink.
     * @returns an asynchronous disposer once the exact watch is ready.
     * @throws when HMR is inactive, the path is already registered, or watcher startup fails.
     */
    registerConfig(filename: string, refresh: () => Promise<void> | void): Promise<() => Promise<void>>;
    /**
     * Resolve a module specifier to a URL, compatible with Node 22-24.
     */
    private _resolve;
    [Service.init](): AsyncGenerator<() => Promise<void>, void, unknown>;
    private refreshConfig;
    getOuterStack: () => string[];
    getLinked(url: string): Promise<string[]>;
    /**
     * Whether a module URL belongs to the framework externals
     * (the dependency tree of the worker entry point). Such files can never
     * be reloaded in-process and require a process restart instead.
     * @agentchat vendored addition
     */
    isExternal(url: string): boolean;
    /**
     * Whether a file URL is a currently loaded module (present in the ESM
     * loadCache). In Node 24 this covers modules imported via import(),
     * regardless of module format.
     * @agentchat vendored addition
     */
    isLoaded(url: string): boolean;
    /**
     * Enumerate loaded (loadCache) file URLs whose mtime is at or after the
     * current reload watermark — the discovery half of the agent-facing
     * `reload_modules` tool. Non-file URLs and vanished files are skipped
     * silently.
     * @agentchat vendored addition — companion of reloadFiles()
     */
    changedSinceWatermark(): Promise<string[]>;
    /**
     * Actively reload the given module URLs (agent-declared completion, see
     * docs/restart-design.md §2).
     *
     * - externals hit → rejected with an error directing to a process restart
     * - each call is a fresh transaction: the stash is replaced, not appended
     * - on success the watermark advances; on failure caches and plugins are
     *   rolled back and the previous tree keeps running
     * @agentchat vendored addition
     */
    reloadFiles(urls: string[]): Promise<ModuleReloadResult>;
    /**
     * Classify changed files into accepted (should reload) and declined (should not).
     *
     * A file is accepted if it's directly changed (stashed) or if any of its
     * dependents are accepted. A file is declined if all its dependents are
     * declined or if it's an external.
     */
    private analyzeChanges;
    private partialReload;
}
declare namespace Hmr {
    interface Config extends ChokidarOptions {
        base?: string;
        root: string[];
        debounce: number;
        ignored: string[];
    }
    const Config: z<Config>;
}
export default Hmr;
//# sourceMappingURL=index.d.ts.map