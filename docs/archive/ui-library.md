# UI 库（自建基础组件库）

> 位置：`src/ui/webui/src/ui/`
> 规范：`docs/webui-design-system.md`（星群 × 工坊）
> 状态：地基已就绪（L0-L2 + 工具组件），重写时逐步接入

## 分层结构

```
src/ui/webui/src/ui/
├── tokens.css        # L0 设计令牌（深空/晨曦双主题，main.ts 已引入）
├── index.ts          # 组件库出口（统一导入入口）
├── icons.ts          # 图标注册表（~icons/lucide/* 自动导入）
├── Icon.vue          # L1 统一图标 <Icon name="send" :size="16" />
├── Button.vue        # L1 按钮 primary/soft/ghost/danger × sm/md
├── Avatar.vue        # L1 头像（图片/首字回退，circle/square）
├── Modal.vue         # L1 弹窗（Teleport+ESC+遮罩关闭）
├── ScrollView.vue    # L1 限高滚动容器（统一滚动条）
├── StatusDot.vue     # 工具 状态灯 thinking/running/idle/ok/err/offline
├── Tooltip.vue       # 工具 CSS hover 提示
├── StarAvatar.vue    # L2 星体头像（光晕 + 活跃呼吸）
├── StarCard.vue      # L2 星卡（会话列表项容器，选中星色描边）
└── PulseTrace.vue    # L2 思维链脉冲轨迹（折叠容器 + 流光）
```

## 使用

```ts
import { Icon, Button, Modal, Avatar, StatusDot, StarAvatar, StarCard, PulseTrace, Tooltip, ScrollView } from '../ui';
```

模板：
```vue
<Button variant="primary" icon="send" @click="go">发送</Button>
<Modal :visible="show" title="标题" @close="show = false">...</Modal>
<StarAvatar :src="agent.avatar" :name="agent.name" :color="starColor" :active="thinking" />
<StarCard :selected="active" :color="starColor">...</StarCard>
<PulseTrace title="思考过程" meta="共 3 步 · 12s" :streaming="running">...</PulseTrace>
<StatusDot status="thinking" />
<Tooltip text="发送"><Icon name="send" /></Tooltip>
```

## 设计令牌（L0）

- 双主题：`html[data-theme="nebula|aurora"]`；**兼容现有 `html.dark/.light`**（已实测：亮→`#f7f7fb`，暗→`#0e121b`）
- 组件只引用令牌变量，禁止硬编码色值
- 发光语义：`--glow-primary`（星体/聚焦）、`--glow-soft`；亮色下自动降级柔光
- 统一滚动条：tokens.css 全局定义，组件无需自写

## 图标

- 依赖 `unplugin-icons` + `@iconify-json/lucide`（vite 已配置 `Icons({ compiler: 'vue3' })`）
- 新增图标：`icons.ts` 的 `iconMap` 加一行（如 `import IconXxx from '~icons/lucide/xxx'`）
- 未注册名称自动兜底为 `info` 图标

## 约定

1. **库无业务知识**：L0-L2 组件不认识 Agent/群组/消息，纯展示；业务逻辑在 L3（现有组件）
2. **只收录出现 ≥2 次且稳定的**：一次性组件直接写在业务组件内，别硬抽象
3. **接入节奏**：重写时把现有散落样式（弹窗/头像/按钮/滚动条）逐步替换为库组件；先替换重复最严重的（Modal、Avatar、图标按钮）
