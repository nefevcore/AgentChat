// llm-pool 通道模块（8.5c 域行 manifest 声明化）——re-export 主线
// ac-client-ui-llm-pool clientPlugin（物理迁出归 cutover）。生成器：
// scripts/gen-domain-channels.mjs（快照漂移先 --check 对账再生成）。
import { llmPoolClientPlugin } from 'ac-client-ui-llm-pool/client';

export default llmPoolClientPlugin;
