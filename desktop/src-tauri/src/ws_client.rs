// WS 通知监听 —— 独立线程连接后端 WS，按规则弹系统通知
//
// 设计（v0.1.0）：
//   · 不依赖 webview 是否打开 —— 托盘常驻时窗口关闭，通知照弹
//   · 只弹用户关心的：Agent 等你回答（chat.interaction）/ 回复完成（chat.message.end）/ 群聊新消息（group.message）
//   · 流式增量（chat.message.update）绝不弹，避免通知风暴
//   · 断线自动 3s 重连（后端重启后自动恢复）
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::connect_async;

const WS_URL: &str = "ws://localhost:3830/ws";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[agentchat-desktop] tokio runtime 创建失败: {e}");
                return;
            }
        };
        rt.block_on(run_loop(app));
    });
}

async fn run_loop(app: AppHandle) {
    loop {
        match connect_and_listen(&app).await {
            Ok(_) => {}
            Err(e) => eprintln!("[agentchat-desktop] WS 监听断开: {e}"),
        }
        // 后端未启动 / 重启中 → 3s 后重连
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn connect_and_listen(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (mut ws, _) = connect_async(WS_URL).await?;
    eprintln!("[agentchat-desktop] 已连接 AgentChat 后端（通知监听就绪）");
    while let Some(msg) = ws.next().await {
        let msg = msg?;
        if msg.is_text() {
            if let Ok(text) = msg.to_text() {
                handle_message(app, text);
            }
        }
    }
    Ok(())
}

/// 事件 → 系统通知（只弹关心的类型）
fn handle_message(app: &AppHandle, text: &str) {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let msg_type = match v.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return,
    };
    match msg_type {
        // Agent 用 ask_questions 等你回答 —— 必须弹（不开窗会错过决策）
        "chat.interaction" => {
            eprintln!("[agentchat-desktop] 收到 chat.interaction，弹通知");
            notify_interaction(app, &v["data"]);
        }
        // Agent 完成一条完整回复 —— 弹（Agent 主动说话的代表）
        "chat.message.end" => {
            eprintln!("[agentchat-desktop] 收到 chat.message.end，弹通知");
            notify_message_end(app, &v["data"]);
        }
        // 群聊新消息
        "group.message" => {
            eprintln!("[agentchat-desktop] 收到 group.message，弹通知");
            notify_group(app, &v["data"]);
        }
        _ => {}
    }
}

fn notify_interaction(app: &AppHandle, data: &Value) {
    let agent = data
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("Agent");
    let question = data
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("在等你回答");
    if let Err(e) = app
        .notification()
        .builder()
        .title(format!("🤔 {agent} 在等你回答"))
        .body(truncate(question, 120))
        .show()
    {
        eprintln!("[agentchat-desktop] 通知发送失败: {e}");
    }
}

fn notify_message_end(app: &AppHandle, data: &Value) {
    let content = data
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if content.trim().is_empty() {
        return;
    }
    let agent = data
        .get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("Agent");
    if let Err(e) = app
        .notification()
        .builder()
        .title(format!("💬 {agent}"))
        .body(truncate(&content, 120))
        .show()
    {
        eprintln!("[agentchat-desktop] 通知发送失败: {e}");
    }
}

fn notify_group(app: &AppHandle, data: &Value) {
    let group = data
        .get("group_id")
        .and_then(|v| v.as_str())
        .unwrap_or("群聊");
    let from = data.get("from").and_then(|v| v.as_str()).unwrap_or("有人");
    let payload = data
        .get("payload")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if let Err(e) = app
        .notification()
        .builder()
        .title(format!("👥 {group}"))
        .body(format!("{from}: {}", truncate(payload, 100)))
        .show()
    {
        eprintln!("[agentchat-desktop] 通知发送失败: {e}");
    }
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(max).collect();
        out.push('…');
        out
    }
}
