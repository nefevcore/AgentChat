// ============================================================
// ac-cdp-core/src/protocol.ts —— CDP 协议词汇（本地最小结构面）
//
// 刻意不引 protocol-tsd/types 包：只用到的域词汇在本文件就地声明，
// 其余按结构化 any 流过（CDP 域上百个，全量类型是维护负担——
// 字段名写错的风险由集成测试对真实浏览器兜底）。设计档案：
// src/docs/browser-cdp-plan.md §4。
// ============================================================

/** 浏览器级 ws 消息（命令与事件共用一条连接） */
export interface CdpWireMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  /** flat session 路由键：命令带它进指定 target，事件带它回来源 target */
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** 分发后的事件（sessionId 已归位到事件本体） */
export interface CdpEventPayload {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Runtime.evaluate 返回的 RemoteObject（截取用到的字段） */
export interface CdpRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  objectId?: string;
}

/** DOMSnapshot.captureSnapshot 的响应——扁平索引数组形态（真实协议：
 * parentIndex/nodeType/nodeName/... 平行数组 + strings 表；嵌套树是误设，
 * 真机首测 2026-09-26 纠正） */
export interface CdpSnapshotDoc {
  strings: string[];
  documents: Array<CdpSnapshotDocument>;
}

export interface CdpSnapshotDocument {
  /** 扁平节点数组（协议字段名是 nodes——真机实测；documentNode 为臆造误设） */
  nodes: CdpFlatNodes;
  title?: number;
  documentURL?: number;
  /** 文档级布局（includeDOMRects 时返回）：nodeIndex[i] = 布局条目 i 对应的节点下标，bounds[i] = [x,y,w,h] */
  layout?: { nodeIndex: number[]; bounds: number[][] };
}

export interface CdpFlatNodes {
  parentIndex: number[];
  nodeType: number[]; // 1=element 3=text 9=document 10=doctype
  nodeName: number[]; // 进 strings
  /** text 节点的文本（进 strings；-1 = 无）——字段名是 textValue 非 nodeValue（真机实测） */
  textValue?: number[];
  nodeValue?: number[];
  backendNodeId: number[];
  attributes: number[][]; // [nameIdx, valueIdx, ...] 平铺对
}

/** Target.getTargets 的 targetInfo（截取用到的字段） */
export interface CdpTargetInfo {
  targetId: string;
  type: string; // 'page' | 'background_page' | ...
  title: string;
  url: string;
  attached: boolean;
}
