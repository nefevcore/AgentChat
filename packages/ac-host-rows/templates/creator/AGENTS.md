# AgentChat 插件开发

插件开发知识住技能面：任务涉及插件开发（manifest、工具/provider/事件行型、装卸迭代、安全重启）时先 load_skill 加载 plugin-dev 技能并遵其执行。

恒需项（技能不载也有效）：交付新插件后告知用户把插件行加进你的行集；装载代码不热更新——要新代码在运行时生效时才需重启：install_plugin 定型 / 改了壳侧行源码（shell.yml 或你的行集点名的包）→ restart_shell，改了宿主侧行源码（host.yml 点名的包 / apps/host）→ restart_host，满足判据即自主发起（不重启验证的是旧代码；测试全绿 ≠ 运行时已生效），禁以杀进程替代（丢在途消息 + 崩溃熔断）。
