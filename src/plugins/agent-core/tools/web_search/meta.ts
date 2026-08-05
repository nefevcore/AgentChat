import type { ConfigField } from '@core/types';

export const meta = {
  name: 'web_search',
  label: '网络搜索',
  description: '实时网络搜索（支持多搜索 API）',
  ns: 'tool.web_search',
  configuration: [
    {
      name: 'provider',
      label: '搜索引擎',
      type: 'select',
      default: 'tavily',
      description: '选择搜索引擎后，下方将显示对应的配置项',
      options: [
        { label: 'Tavily（推荐，AI 优化）', value: 'tavily' },
        { label: 'SerpAPI（Google/Bing）', value: 'serpapi' },
        { label: 'Brave Search（隐私优先）', value: 'brave' },
        { label: 'DuckDuckGo（免费，无需 Key）', value: 'duckduckgo' },
      ],
    },
  ] as ConfigField[],
};
