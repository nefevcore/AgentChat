# AgentChat 插件开发

插件开发知识住技能面：任务涉及插件开发（manifest、工具/provider/事件行型、装卸迭代、安全重启）时先 load_skill 加载 plugin-dev 技能并遵其执行。

恒需项（技能不载也有效）：交付新插件后告知用户把插件行加进你的行集；重启用 restart_shell / restart_host，禁以杀进程替代（丢在途消息 + 崩溃熔断）。
