// ============================================================
// ui/icons.ts —— 图标集中注册表
// 使用 unplugin-icons 自动导入（~icons/lucide/xxx）
// 新增图标：在 iconMap 加一行即可，组件统一 <Icon name="..." />
// ============================================================

import type { Component } from 'vue';

// lucide 图标（https://lucide.dev）
import IconMessageCircle from '~icons/lucide/message-circle';
import IconUsers from '~icons/lucide/users';
import IconFolder from '~icons/lucide/folder';
import IconActivity from '~icons/lucide/activity';
import IconSettings from '~icons/lucide/settings';
import IconMoreHorizontal from '~icons/lucide/more-horizontal';
import IconSearch from '~icons/lucide/search';
import IconPlus from '~icons/lucide/plus';
import IconSend from '~icons/lucide/send';
import IconPaperclip from '~icons/lucide/paperclip';
import IconSparkles from '~icons/lucide/sparkles';
import IconCopy from '~icons/lucide/copy';
import IconPencil from '~icons/lucide/pencil';
import IconTrash from '~icons/lucide/trash';
import IconRefresh from '~icons/lucide/refresh-cw';
import IconTerminal from '~icons/lucide/terminal';
import IconFile from '~icons/lucide/file';
import IconFileText from '~icons/lucide/file-text';
import IconCode from '~icons/lucide/code';
import IconDownload from '~icons/lucide/download';
import IconChevronDown from '~icons/lucide/chevron-down';
import IconChevronUp from '~icons/lucide/chevron-up';
import IconChevronLeft from '~icons/lucide/chevron-left';
import IconChevronRight from '~icons/lucide/chevron-right';
import IconArrowLeft from '~icons/lucide/arrow-left';
import IconArrowRight from '~icons/lucide/arrow-right';
import IconArrowUp from '~icons/lucide/arrow-up';
import IconMousePointerClick from '~icons/lucide/mouse-pointer-click';
import IconKeyboard from '~icons/lucide/keyboard';
import IconCornerDownLeft from '~icons/lucide/corner-down-left';
import IconGlobe from '~icons/lucide/globe';
import IconCheck from '~icons/lucide/check';
import IconPlay from '~icons/lucide/play';
import IconGripVertical from '~icons/lucide/grip-vertical';
import IconX from '~icons/lucide/x';
import IconMenu from '~icons/lucide/menu';
import IconSun from '~icons/lucide/sun';
import IconMoon from '~icons/lucide/moon';
import IconAlertCircle from '~icons/lucide/alert-circle';
import IconCheckCircle from '~icons/lucide/check-circle';
import IconClock from '~icons/lucide/clock';
import IconZap from '~icons/lucide/zap';
import IconStop from '~icons/lucide/octagon';
import IconPause from '~icons/lucide/pause';
import IconLink from '~icons/lucide/link';
import IconBan from '~icons/lucide/ban';
import IconRotateCcw from '~icons/lucide/rotate-ccw';
import IconExternalLink from '~icons/lucide/external-link';
import IconBookOpen from '~icons/lucide/book-open';
import IconStar from '~icons/lucide/star';
import IconInfo from '~icons/lucide/info';
import IconWrench from '~icons/lucide/wrench';
import IconGitBranch from '~icons/lucide/git-branch';
import IconBrainCircuit from '~icons/lucide/brain-circuit';
import IconImage from '~icons/lucide/image';
import IconFileJson from '~icons/lucide/file-json';
import IconFileArchive from '~icons/lucide/file-archive';
import IconFileCode from '~icons/lucide/file-code';
import IconPanelRight from '~icons/lucide/panel-right';
import IconCpu from '~icons/lucide/cpu';
import IconLock from '~icons/lucide/lock';
import IconFolderPlus from '~icons/lucide/folder-plus';
import IconFolderOpen from '~icons/lucide/folder-open';
import IconBot from '~icons/lucide/bot';
import IconTarget from '~icons/lucide/target';
import IconLoaderCircle from '~icons/lucide/loader-circle';

/** 图标注册表：name → 组件 */
export const iconMap: Record<string, Component> = {
  'message-circle': IconMessageCircle,
  users: IconUsers,
  folder: IconFolder,
  activity: IconActivity,
  settings: IconSettings,
  'more-horizontal': IconMoreHorizontal,
  search: IconSearch,
  plus: IconPlus,
  send: IconSend,
  paperclip: IconPaperclip,
  sparkles: IconSparkles,
  copy: IconCopy,
  pencil: IconPencil,
  trash: IconTrash,
  'refresh-cw': IconRefresh,
  terminal: IconTerminal,
  file: IconFile,
  'file-text': IconFileText,
  code: IconCode,
  download: IconDownload,
  'chevron-down': IconChevronDown,
  'chevron-up': IconChevronUp,
  'chevron-left': IconChevronLeft,
  'chevron-right': IconChevronRight,
  'arrow-left': IconArrowLeft,
  'arrow-right': IconArrowRight,
  'arrow-up': IconArrowUp,
  'mouse-pointer-click': IconMousePointerClick,
  keyboard: IconKeyboard,
  'corner-down-left': IconCornerDownLeft,
  globe: IconGlobe,
  check: IconCheck,
  play: IconPlay,
  'grip-vertical': IconGripVertical,
  x: IconX,
  menu: IconMenu,
  sun: IconSun,
  moon: IconMoon,
  'alert-circle': IconAlertCircle,
  'check-circle': IconCheckCircle,
  clock: IconClock,
  zap: IconZap,
  stop: IconStop,
  pause: IconPause,
  link: IconLink,
  ban: IconBan,
  'rotate-ccw': IconRotateCcw,
  'external-link': IconExternalLink,
  'book-open': IconBookOpen,
  star: IconStar,
  info: IconInfo,
  wrench: IconWrench,
  'git-branch': IconGitBranch,
  'brain-circuit': IconBrainCircuit,
  image: IconImage,
  'file-json': IconFileJson,
  'file-archive': IconFileArchive,
  'file-code': IconFileCode,
  'panel-right': IconPanelRight,
  cpu: IconCpu,
  lock: IconLock,
  'folder-plus': IconFolderPlus,
  'folder-open': IconFolderOpen,
  bot: IconBot,
  target: IconTarget,
  'loader-circle': IconLoaderCircle,
};

/** 未注册图标的兜底 */
export const fallbackIcon = IconInfo;

export function resolveIcon(name: string): Component {
  return iconMap[name] ?? fallbackIcon;
}
