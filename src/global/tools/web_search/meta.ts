import type { ConfigField } from '../../../discovery/config-types';

export const meta = {
  name: 'web_search',
  label: '网络搜索',
  description: '实时网络搜索',
  ns: 'tool.web_search',
  configuration: [
    { name: 'defaultResults', label: '默认结果数', type: 'number', default: 5 },
    { name: 'defaultDepth', label: '搜索深度', type: 'select', default: 'advanced',
      options: [
        { label: '基础', value: 'basic' },
        { label: '高级', value: 'advanced' },
        { label: '快速', value: 'fast' },
        { label: '极速', value: 'ultra-fast' },
      ] },
    { name: 'defaultTopic', label: '搜索类别', type: 'select', default: 'general',
      options: [
        { label: '通用', value: 'general' },
        { label: '新闻', value: 'news' },
        { label: '财经', value: 'finance' },
      ] },
    { name: 'rawContentMaxLen', label: '内容截断长度', type: 'number', default: 2000 },
  ] as ConfigField[],
};
