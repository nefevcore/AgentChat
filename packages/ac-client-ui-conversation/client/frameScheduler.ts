// ============================================================
// client/frameScheduler.ts —— 单 rAF 流水线调度器（cr-1287 P4-2）
//
// 病灶（docs/design/archive/session/session-render-pipeline-plan.md §一 1.2 末段，已归档）：五个独立节拍交错——
// feed 同步直写 / markdown 自持 rAF + idle-commit setTimeout / 滚动 rAF /
// refill setTimeout——闪烁节律不齐，且「每帧提交次数」无处断言。
//
// 终态：一条 rAF 链按阶段序执行同帧任务——
//   ingest → derive → commit（markdown）→ scroll
// 同帧内各阶段任务按登记序执行、每阶段只跑一次；跨阶段顺序是构造性保证
// （提交先于滚动：本帧渲染出的新高度当帧即被滚动引擎看到，不再等下一帧）。
//
// 静默判据升为调度器级（§四 P4-2「idle-commit 升为调度器级静默判据」）：
// 活动时钟由 markActivity 单点维护（feed ingest / 组件 update / flush 均
// 打点），静默订阅者（markdown idle-commit 等）共用同一判据——不再各自
// 持定时器各算各的「静止」。
//
// 探针：noteCommit 记提交次数，frameStats 读；测试断言「每帧恰一次提交」
// （cr-258 P3 原始提案的验收口径）。
// ============================================================

/** 帧内阶段（顺序即执行序：后阶段可见前阶段的写入） */
export type FrameStage = 'ingest' | 'derive' | 'commit' | 'scroll';

const ORDER: readonly FrameStage[] = ['ingest', 'derive', 'commit', 'scroll'];

const stageQueues = new Map<FrameStage, Set<() => void>>();
let raf = 0;
/** 常驻持帧引用数（>0 时空帧也继续调度——跟随引擎等持续任务） */
let retainers = 0;

interface IdleSub {
  ms: number;
  cb: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}
const idleSubs = new Set<IdleSub>();

const stats = {
  frames: 0,
  tasks: 0,
  /** 实际提交（markdown 重渲染）次数 */
  commits: 0,
  /** 单帧最大提交次数（=1 即「每帧恰一次提交」达标） */
  maxCommitsPerFrame: 0,
  /** 静默提交触发次数（idle-commit） */
  idleCommits: 0,
};
let frameCommits = 0;

function kick(): void {
  if (raf) return;
  raf = requestAnimationFrame(tick);
}

function tick(): void {
  raf = 0;
  let ran = 0;
  frameCommits = 0;
  for (const stage of ORDER) {
    const q = stageQueues.get(stage);
    if (q === undefined || q.size === 0) continue;
    // 快照后清空：任务内新登记的同阶段任务落到下一帧（避免同帧自激）
    const tasks = [...q];
    q.clear();
    for (const task of tasks) {
      try {
        task();
      } catch (err) {
        // 单任务失败不拖垮整帧（其余阶段照常推进）；现场留日志
        console.error('[frameScheduler]', stage, err);
      }
      ran++;
    }
  }
  stats.frames++;
  stats.tasks += ran;
  if (frameCommits > stats.maxCommitsPerFrame) stats.maxCommitsPerFrame = frameCommits;
  if (retainers > 0) kick();
}

/** 登记一个帧内任务（同一阶段同一帧内按登记序执行） */
export function scheduleFrame(stage: FrameStage, task: () => void): void {
  let q = stageQueues.get(stage);
  if (q === undefined) {
    q = new Set();
    stageQueues.set(stage, q);
  }
  q.add(task);
  kick();
}


/** 常驻持帧（返回释放函数）：跟随引擎等持续任务保活调度循环 */
export function retainLoop(): () => void {
  retainers++;
  kick();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainers = Math.max(0, retainers - 1);
  };
}

/** 活动打点（ingest / update / flush）：重置全部静默订阅的计时 */
export function markActivity(): void {
  for (const sub of idleSubs) {
    if (!sub.active) continue;
    if (sub.timer !== null) clearTimeout(sub.timer);
    sub.timer = setTimeout(() => {
      sub.timer = null;
      if (!sub.active) return;
      // 一次性语义：触发即退订（调用方按需重新订阅——如 markdown 每次
      // 出现待提交尾部时重新 arm）
      sub.active = false;
      idleSubs.delete(sub);
      sub.cb();
    }, sub.ms);
  }
}

/** 静默订阅：markActivity 后持续 ms 无活动则执行 cb（返回取消函数）。
 *  多个订阅者共用同一活动时钟——「静止」是一次判定而非各自计时。 */
export function whenIdle(ms: number, cb: () => void): () => void {
  const sub: IdleSub = { ms, cb, timer: null, active: true };
  idleSubs.add(sub);
  markActivity(); // 新订阅立即起算（调用点通常刚发生过 update）
  return () => {
    sub.active = false;
    if (sub.timer !== null) clearTimeout(sub.timer);
    sub.timer = null;
    idleSubs.delete(sub);
  };
}

/** 提交打点（markdown 实际重渲染时调用——「每帧恰一次提交」探针源） */
export function noteCommit(idle = false): void {
  stats.commits++;
  frameCommits++;
  if (idle) stats.idleCommits++;
}

export interface FrameStats {
  frames: number;
  tasks: number;
  commits: number;
  maxCommitsPerFrame: number;
  idleCommits: number;
}

/** 统计读面（测试断言 / 控制台观察） */
export function frameStats(): FrameStats {
  return { ...stats };
}

/** 测试复位（清队列/统计/静默订阅；不触碰 rAF 已排程的一拍） */
export function resetFrameScheduler(): void {
  for (const q of stageQueues.values()) q.clear();
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  for (const sub of idleSubs) {
    sub.active = false;
    if (sub.timer !== null) clearTimeout(sub.timer);
  }
  idleSubs.clear();
  retainers = 0;
  frameCommits = 0;
  stats.frames = 0; stats.tasks = 0; stats.commits = 0;
  stats.maxCommitsPerFrame = 0; stats.idleCommits = 0;
}

