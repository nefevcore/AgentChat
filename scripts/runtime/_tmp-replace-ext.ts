const fs = require('fs');
const p = 'c:/Users/xiaofeng/Documents/Dev/AgentChat/src/ui/webui/src/settings/components/AgentPane.vue';
let src = fs.readFileSync(p, 'utf-8');
const startMark = '<!-- ====== 扩展与工具 ====== -->';
const start = src.indexOf(startMark);
if (start < 0) { console.log('start mark not found'); process.exit(1); }
const endTpl = src.lastIndexOf('</template>');
if (endTpl <= start) { console.log('bad endTpl'); process.exit(1); }
const seg = src.slice(start, endTpl);
const lastTel = seg.lastIndexOf('</Teleport>');
if (lastTel < 0) { console.log('Teleport not found in seg'); process.exit(1); }
const afterTel = seg.slice(lastTel);
const m = afterTel.match(/\r?\n    <\/div>\r?\n  <\/div>\r?\n$/);
if (!m) { console.log('closing div pattern not found; afterTel tail:', JSON.stringify(afterTel.slice(-80))); process.exit(1); }
const replaceEnd = start + lastTel + m.index + m[0].length;
const repl = [
  '    <!-- ====== 扩展与工具 ====== -->',
  '    <div v-else class="ext-pane">',
  '      <ExtToolsPane',
  '        mode="agent"',
  '        :hooks="plugins"',
  '        :decl="builtinDecl()"',
  '        :on-decl="patchBuiltin"',
  '        :tools="agentTools ?? { catalog: [], enabled: [], explicit: [] }"',
  '        :tags="raw.tags"',
  '        :ns-schemas="nsSchemas"',
  '        :config="globalConfig"',
  '        :allowed-paths="raw.allowedPaths"',
  '      />',
  '    </div>',
  '',
].join('\n');
src = src.slice(0, start) + repl + src.slice(replaceEnd);
fs.writeFileSync(p, src, 'utf-8');
console.log('replaced, removed length:', replaceEnd - start);
