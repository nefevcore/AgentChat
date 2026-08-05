import type { ConfigField } from '@core/types';

export const meta = {
  name: 'read',
  label: '读取文件',
  description: '读取文件内容或列出目录结构。',
  ns: 'tool.read',
  configuration: [
    { name: 'maxLines', label: '最大读取行数', type: 'number', default: 2000 },
    { name: 'maxBytes', label: '最大读取字节数', type: 'number', default: 50 * 1024 },
  ] as ConfigField[],
};
