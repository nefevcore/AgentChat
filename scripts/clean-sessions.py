#!/usr/bin/env python3
"""
清理所有会话 JSONL 文件中的脏数据，逐条重建确保收敛：

- 悬空 assistant(tool_calls)（缺 tool 结果）→ 合成 tool 结果补全
- 孤儿 tool 消息（tool_call_id 不匹配活跃 assistant）→ 跳过
- 空 assistant 消息（无 content / tool_calls / reasoning）→ 跳过

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

def synth_tool_result(tc_id, tc_name):
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
    """单文件清洗：返回干净的消息列表"""
    n = len(msgs)
    out = []
    i = 0
    repairs = 0
    removed = 0

    while i < n:
        m = msgs[i]
        if not m:
            i += 1
            continue

        # 跳过空消息
        if is_empty_msg(m):
            removed += 1
            i += 1
            continue

        # 处理带 tool_calls 的消息
        if is_toolcall_msg(m):
            tc_list = m.get('tool_calls', [])
            expected_ids = [tc['id'] for tc in tc_list]
            found = []

            # 向前扫描 tool 结果
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

            # 输出 assistant
            out.append(m)

            # 输出已有的 tool 结果（按出现顺序）
            for fj in found:
                out.append(msgs[fj])
                if msgs[fj].get('tool_call_id', '') in expected_ids:
                    expected_ids.remove(msgs[fj].get('tool_call_id', ''))

            # 补全缺失的 tool 结果
            for tc in tc_list:
                if tc['id'] in expected_ids:
                    tc_name = tc.get('function', {}).get('name', tc.get('name', 'unknown'))
                    out.append(synth_tool_result(tc['id'], tc_name))
                    repairs += 1

            i = j  # 跳到 tool 结果之后
            continue

        # 孤儿 tool 消息 → 跳过
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
