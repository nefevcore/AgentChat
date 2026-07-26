// ============================================================
// web_search Provider Schemas —— 各搜索引擎的 UI 配置项定义
//
// 导出 *_SEARCH_SCHEMA 供 API 自动扫描，前端按 provider 整组切换。
// ============================================================

import type { ConfigField } from '@discovery/config-types';

export const TAVILY_SEARCH_SCHEMA: ConfigField[] = [
  { name: 'tavilyApiKey', label: 'API 密钥', type: 'string', default: '',
    description: 'AES-256-GCM 加密存储。免费注册：https://app.tavily.com' },
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
];

export const SERPAPI_SEARCH_SCHEMA: ConfigField[] = [
  { name: 'serpapiApiKey', label: 'API 密钥', type: 'string', default: '',
    description: 'AES-256-GCM 加密存储。免费注册：https://serpapi.com' },
  { name: 'defaultResults', label: '默认结果数', type: 'number', default: 5 },
  { name: 'defaultDepth', label: '搜索深度', type: 'select', default: 'advanced',
    options: [
      { label: '基础', value: 'basic' },
      { label: '高级', value: 'advanced' },
    ] },
  { name: 'defaultTopic', label: '搜索类别', type: 'select', default: 'general',
    options: [
      { label: '通用', value: 'general' },
      { label: '新闻', value: 'news' },
    ] },
  { name: 'rawContentMaxLen', label: '内容截断长度', type: 'number', default: 2000 },
];

export const BRAVE_SEARCH_SCHEMA: ConfigField[] = [
  { name: 'braveApiKey', label: 'API 密钥', type: 'string', default: '',
    description: 'AES-256-GCM 加密存储。免费注册：https://brave.com/search/api/' },
  { name: 'defaultResults', label: '默认结果数', type: 'number', default: 5 },
  { name: 'defaultDepth', label: '搜索深度', type: 'select', default: 'advanced',
    options: [
      { label: '基础', value: 'basic' },
      { label: '高级', value: 'advanced' },
    ] },
  { name: 'defaultTopic', label: '搜索类别', type: 'select', default: 'general',
    options: [
      { label: '通用', value: 'general' },
      { label: '新闻', value: 'news' },
    ] },
  { name: 'rawContentMaxLen', label: '内容截断长度', type: 'number', default: 2000 },
];

export const DUCKDUCKGO_SEARCH_SCHEMA: ConfigField[] = [
  { name: 'defaultResults', label: '默认结果数', type: 'number', default: 5 },
  { name: 'defaultDepth', label: '搜索深度', type: 'select', default: 'advanced',
    options: [
      { label: '基础', value: 'basic' },
      { label: '高级', value: 'advanced' },
    ] },
  { name: 'defaultTopic', label: '搜索类别', type: 'select', default: 'general',
    options: [
      { label: '通用', value: 'general' },
    ] },
  { name: 'rawContentMaxLen', label: '内容截断长度', type: 'number', default: 2000 },
];
