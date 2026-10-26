// plugin-registry 通道模块（8.5c 域行 manifest 声明化）——re-export 主线
// ac-client-ui-plugin-registry clientPlugin（物理迁出归 cutover）。生成器：
// scripts/gen-domain-channels.mjs（快照漂移先 --check 对账再生成）。
import { pluginRegistryClientPlugin } from 'ac-client-ui-plugin-registry/client';

export default pluginRegistryClientPlugin;
