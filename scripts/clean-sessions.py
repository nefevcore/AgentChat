#!/usr/bin/env python3
"""
清理所有会话 JSONL 文件中的脏数据，逐条重建确保收敛。

## 重建规则（单向：Agent → Tool）

✅ 允许：根据 Agent(tool_calls) 重建缺失的 tool 结果
   - Agent 消息带有 tool_calls 但缺少对应 tool 结果 → 合成 tool 结果补全
   - 已存在的 tool 结果原样保留

❌ 禁止：根据 Tool 消息重建 Agent 消息
   - 孤儿 tool 消息（无前置 Agent tool_calls）→ 直接删除
   - 绝不合成 Agent 消息

## 其他清理

- role='user'/'assistant' → 统一规范化为 'agent'
- 空消息（无 content / tool_calls / reasoning）→ 删除
- 空 tool_call（content='' + arguments='{}'）→ 删除（cleaner 历史冗余）
- 重复 tool_call_id → 删除（同一 ID 已在前面处理过）

核心：顺序遍历，逐条决定保留/跳过/补全，直接输出新列表。
反复运行结果不变（幂等）。

用法：python scripts/clean-sessions.py
"""
import os, json, sys
from datetime import datetime, timezone

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'workspace', 'default', 'sessions')
if not os.path.isdir(BASE):
    BASE = os.path.join(os.getcwd(), 'workspace', 'default', 'sessions')

NOW = datetime.now(timezone.utc).isoformat()

# ---- 仅允许的合成函数：只创建 tool 结果，绝不创建 agent 消息 ----

def synth_tool_result(tc_id, tc_name):
    """根据 Agent 的 tool_call 合成缺失的 tool 结果（唯一允许的合成方向）"""
    return {
        'role': 'tool',
        'content': json.dumps({'status': 'success', 'data': '(synthesized)', 'synthesized': True}, ensure_ascii=False),
        'tool_call_id': tc_id,
        'name': tc_name or 'unknown',
        'timestamp': NOW,
    }

def is_toolcall_msg(m):
    """消息是否带有 tool_calls"""
    if not m: return False
    r = m.get('role', '')
    return r in ('assistant', 'agent', 'user') and bool(m.get('tool_calls'))

def is_empty_msg(m):
    """空 assistant/user 消息（无实质内容）"""
    if not m: return True
    r = m.get('role', '')
    return (r in ('assistant', 'agent', 'user')
            and not m.get('content')
            and not m.get('tool_calls')
            and not m.get('reasoning_content'))

def clean_messages(msgs):
    """
    单文件清洗：返回干净的消息列表。

    规则：
    1. ✅ Agent(tool_calls) → 缺失 tool 结果 → 合成补全
    2. ❌ 孤儿 tool → 绝不据此重建 Agent，直接删除
    3. 重复 tool_call_id → 删除（已处理过）
    """
    n = len(msgs)
    out = []
    i = 0
    repairs = 0
    removed = 0
    seen_tool_call_ids = set()  # 已处理的 tool_call_id，防重复合成

    while i < n:
        m = msgs[i]
        if not m:
            i += 1
            continue

        # 规范化 role：持久化格式统一用 'agent'
        r = m.get('role', '')
        if r in ('user', 'assistant'):
            m = dict(m, role='agent')
            repairs += 1

        # 跳过空消息
        if is_empty_msg(m):
            removed += 1
            i += 1
            continue

        # ── ✅ 规则1：Agent(tool_calls) 可以重建缺失的 tool 结果 ──
        if is_toolcall_msg(m):
            tc_list = m.get('tool_calls', [])
            expected_ids = [tc['id'] for tc in tc_list]

            # 检测"空 tool_call"：content 为空 + 所有 arguments 为 "{}"
            # 这是 cleaner 历史重建产生的冗余噪音
            content = (m.get('content') or '').strip()
            all_args_empty = all(
                (tc.get('function', {}).get('arguments', '') or '').strip() in ('', '{}')
                for tc in tc_list
            )
            if not content and all_args_empty:
                removed += 1
                # 跳过后续匹配的 tool 结果
                i += 1
                while i < n:
                    nxt = msgs[i]
                    if nxt and nxt.get('role') == 'tool' and nxt.get('tool_call_id', '') in expected_ids:
                        removed += 1
                        i += 1
                    else:
                        break
                continue

            # 检测重复 tool_call_id：全部 ID 都已见过 → 跳过
            all_seen = all(tid in seen_tool_call_ids for tid in expected_ids)
            if all_seen:
                removed += 1
                # 跳过后续匹配的 tool 结果
                i += 1
                while i < n:
                    nxt = msgs[i]
                    if nxt and nxt.get('role') == 'tool' and nxt.get('tool_call_id', '') in expected_ids:
                        removed += 1
                        i += 1
                    else:
                        break
                continue

            # 向前扫描已存在的 tool 结果
            found = []
            j = i + 1
            while j < n:
                nxt = msgs[j]
                if not nxt:
                    j += 1
                    continue
                if nxt.get('role') == 'tool':
                    tid = nxt.get('tool_call_id', '')
                    if tid in expected_ids:
                        found.append(j)
                elif nxt.get('role') == 'error':
                    j += 1
                    continue
                else:
                    break
                j += 1

            # 输出 Agent 消息
            out.append(m)

            # 输出已有的 tool 结果（按出现顺序）
            for fj in found:
                tmsg = msgs[fj]
                tid = tmsg.get('tool_call_id', '')
                if tid not in seen_tool_call_ids:
                    out.append(tmsg)
                    seen_tool_call_ids.add(tid)
                else:
                    removed += 1  # 重复 tool 结果
                if tid in expected_ids:
                    expected_ids.remove(tid)

            # 补全缺失的 tool 结果（仅合成方向：Agent → Tool）
            for tc in tc_list:
                if tc['id'] in expected_ids and tc['id'] not in seen_tool_call_ids:
                    tc_name = tc.get('function', {}).get('name', tc.get('name', 'unknown'))
                    out.append(synth_tool_result(tc['id'], tc_name))
                    seen_tool_call_ids.add(tc['id'])
                    repairs += 1

            # 标记所有 ID 为已处理
            for tc in tc_list:
                seen_tool_call_ids.add(tc['id'])

            i = j
            continue

        # ── ❌ 规则2：孤儿 tool 消息 → 绝不据此重建 Agent，直接删除 ──
        if m.get('role') == 'tool':
            removed += 1
            i += 1
            continue

        # 普通消息 → 保留
        out.append(m)
        i += 1

    return out, repairs, removed

fixed = 0
total_repaired = 0
total_removed = 0

for root, dirs, files in os.walk(BASE):
    targets = []
    for f in files:
        if f == 'messages.jsonl' or (f.startswith('history_') and f.endswith('.jsonl')):
            targets.append(f)

    for f in targets:
        path = os.path.join(root, f)
        try:
            with open(path, 'r', encoding='utf-8-sig') as fh:
                raw = fh.read()
        except Exception as e:
            print(f'[SKIP] {os.path.relpath(path, BASE)}: {e}')
            continue

        msgs = []
        for line in raw.strip().split('\n'):
            line = line.strip()
            if not line: continue
            try:
                msgs.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 跳过解析失败的行

        if not msgs:
            continue

        new_msgs, repairs, removed = clean_messages(msgs)

        if repairs > 0 or removed > 0:
            rel = os.path.relpath(path, BASE)
            with open(path, 'w', encoding='utf-8') as fh:
                for m in new_msgs:
                    fh.write(json.dumps(m, ensure_ascii=False) + '\n')
            fixed += 1
            total_repaired += repairs
            total_removed += removed
            desc = []
            if repairs: desc.append(f'+{repairs} repaired')
            if removed: desc.append(f'-{removed} removed')
            print(f'{rel}: {len(msgs)} msgs -> {", ".join(desc)}')

print(f'\nDone: {fixed} files, {total_repaired} repaired, {total_removed} removed')
