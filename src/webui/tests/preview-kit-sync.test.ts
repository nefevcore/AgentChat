// ============================================================
// webui/tests/preview-kit-sync.test.ts —— 预览页 ↔ kit 事实源一致性（cr-121）
//
// 背景：预览页（原 v2.html，已退役）曾手抄 kit 令牌/组件样式，评审看到的常与源码
// 不一致（「预览页有焦点环、源码没有」这类结论就来自漂移）。现改为
// scripts/build-webui-preview.mjs 注入，本测试是该注入的守门：
//   ① 标记区内容 ≠ 事实源 → 红灯（提示重跑注入脚本）；
//   ② 标记本身缺失 → 红灯（防有人删标记后静默退回手抄）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// 单页注入：v2 答辩版已退役（被 gallery 取代）
const pages = ['src/webui/design/gallery.html'].map((p) => ({
  path: p,
  html: readFileSync(join(repo, p), 'utf8'),
}));

describe('预览页 kit 片段注入（cr-121）', () => {
  it('① 注入区与 kit 事实源一致（node scripts/build-webui-preview.mjs --check）', () => {
    const run = () =>
      execFileSync(process.execPath, ['scripts/build-webui-preview.mjs', '--check'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ["ignore", "pipe", "pipe"],
      });
    expect(run, '预览页与 kit 源不一致——跑 node scripts/build-webui-preview.mjs').not.toThrow();
  });

  it('② 注入标记齐备（含星色板），且不再手抄令牌块', () => {
    const tags = [
      'base/tokens.css', 'base/row.css', 'base/badge.css', 'base/dropdown.css', 'starColor.ts',
      'base/Button.vue', 'base/Avatar.vue', 'base/StatusDot.vue', 'base/Tooltip.vue',
      'base/RingProgress.vue', 'base/BusyRing.vue', 'base/CollapseRow.vue', 'base/DockCard.vue',
      'feedback/FeedbackNotice.vue', 'feedback/ToastHost.vue',
      'base/Modal.vue', 'base/Sheet.vue', 'base/PullToRefresh.vue', 'star/StarAvatar.vue',
      'base/Chip.vue', 'base/IconAction.vue', 'base/Progress.vue', 'base/Breadcrumb.vue',
      'base/ConfirmBody.vue', 'base/OptionRow.vue', 'base/PickTag.vue',
      'base/Segmented.vue', 'base/Tabs.vue', 'base/DocTabs.vue', 'base/Select.vue', 'base/DatePicker.vue',
      'base/Input.vue', 'base/Textarea.vue', 'base/Checkbox.vue', 'base/Slider.vue',
      'base/FieldRow.vue', 'base/Label.vue', 'base/SearchInput.vue', 'base/PasswordInput.vue',
    ];
    for (const { path, html: preview } of pages) {
      for (const tag of tags) expect(preview.includes(`/* @kit:${tag} */`), `${path} 缺标记 @kit:${tag}`).toBe(true);
      expect(preview.split('/* @end */').length - 1, `${path} @end 数量应与标记数一致`).toBe(tags.length);
      // 手抄痕迹：★/⚙ 字形标记与预览页私有的开关配色都不该再出现
      expect(preview.includes('★'), `${path} 不应再用 ★ 字形标记`).toBe(false);
      // 旧手抄开关（display:none 摘掉可达性树那版）不得残留
      expect(preview.includes('.ui-switch input{display:none}'), `${path} 开关配方应来自 row.css 而非手抄`).toBe(false);
    }
  });
});
