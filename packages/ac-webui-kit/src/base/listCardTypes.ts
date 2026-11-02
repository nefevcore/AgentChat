// ============================================================
// webui-kit/src/base/listCardTypes.ts —— ListCard 行条目类型
// （cr-765 批次A）：SFC 内 export interface 经 vue-tsc 可见但根 tsc 的
// *.vue shim 不透传具名导出——类型面独立成文件（kit 首例组件伴随类型）。
// ============================================================

export interface ListCardItem {
  /** 行主键（渲染 key） */
  key: string | number;
  /** 行首语义图标名（icons.ts 注册名；缺省 file-text） */
  icon?: string;
  /** 行首图标着色：中性 / primary（目录）/ ok / err / run */
  iconTone?: '' | 'primary' | 'ok' | 'err' | 'run';
  /** 主文本（单行截断） */
  title: string;
  /** 次文本（单行截断，text-3） */
  sub?: string;
  /** 行尾元信息（等宽小字） */
  meta?: string;
  /** 状态第二列图标（check/x/loader-circle 等） */
  status?: string;
  /** 状态图标着色（同 iconTone 语义 + warn） */
  statusTone?: '' | 'primary' | 'ok' | 'err' | 'warn' | 'run';
  /** 行内嵌详情（原地展开区，行点击切换；缺省无展开） */
  detail?: string;
  /** 整行失败底（browser 失败步等） */
  failed?: boolean;
}
