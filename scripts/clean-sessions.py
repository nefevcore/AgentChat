#!/usr/bin/env python3
"""
清理所有会话 JSONL 文件中的脏数据，优先补全而非删除：

- 悬空 assistant(tool_calls)（缺 tool 结果）→ 合成 tool 结果补全
- 孤儿 tool 消息（tool_call_id 不匹配任何活跃 assistant）→ 合成 assistant 包裹
- 空 assistant 消息（无 content / tool_calls / reasoning）→ 删除

用法：python scripts/clean-sessions.py
"""
import os, json, sys, re
from datetime import datetime, timezone

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'workspace', 'default', 'sessions')
if not os.path.isdir(BASE):
    BASE = os.path.join(os.getcwd(), 'workspace', 'default', 'sessions')

NOW = datetime.now(timezone.utc).isoformat()

def make_tool_result(tc_id, tc_name):
    """合成一条 tool 结果消息"""
    return {
        'role': 'tool',
        'content': json.dumps({'status': 'success', 'data': '(synthesized by cleaner)', 'synthesized': True}, ensure_ascii=False),
        'tool_call_id': tc_id,
        'name': tc_name or 'unknown',
        'timestamp': NOW,
    }

def make_assistant(tool_calls):
    """合成一条包含 tool_calls 的 assistant 消息"""
    return {
        'role': 'agent',
        'content': '',
        'tool_calls': tool_calls,
        'timestamp': NOW,
    }

def is_assistant_with_tc(m):
    if not m: return False
    r = m.get('role', '')
    return r in ('assistant', 'agent') and bool(m.get('tool_calls'))

def is_empty_assistant(m):
    if not m: return False
    r = m.get('role', '')
    return (r in ('assistant', 'agent')
            and not m.get('content')
            and not m.get('tool_calls')
            and not m.get('reasoning_content'))

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
            for part in re.split(r'(?<=\})\s*(?=\{)', line.strip()):
                part = part.strip()
                if not part: continue
                try:
                    msgs.append(json.loads(part))
                except json.JSONDecodeError:
                    msgs.append(None)
        if not msgs:
            continue

        n = len(msgs)
        keep = [True] * n
        synthesized = []
        repairs = 0

        # ── Pass 1: 补全悬空 assistant(tool_calls) ──
        for i in range(n):
            m = msgs[i]
            if not keep[i] or not is_assistant_with_tc(m):
                continue
            tc = m.get('tool_calls')
            found_ids = set()
            for j in range(i + 1, n):
                nxt = msgs[j]
                if not nxt:
                    continue
                if nxt.get('role') == 'tool':
                    found_ids.add(nxt.get('tool_call_id', ''))
                elif nxt.get('role') == 'error':
                    continue
                else:
                    break
            missing = [tc_item for tc_item in tc if tc_item['id'] not in found_ids]
            if missing:
                insert_at = i + 1
                gap = 0
                for tc_item in missing:
                    tc_name = tc_item.get('function', {}).get('name', tc_item.get('name', 'unknown'))
                    synthesized.append((insert_at + gap, make_tool_result(tc_item['id'], tc_name)))
                    gap += 1
                    repairs += 1

        # ── Pass 2: 补全孤儿 tool 消息 ──
        active_ids = set()
        for i in range(n):
            m = msgs[i]
            if not m:
                active_ids = set()
                continue
            if is_assistant_with_tc(m):
                active_ids = set(tc['id'] for tc in m['tool_calls'])
            elif m.get('role') not in ('tool', 'error'):
                active_ids = set()
            if m.get('role') == 'tool':
                tc_id = m.get('tool_call_id', '')
                if tc_id and tc_id not in active_ids:
                    tc_name = m.get('name', 'unknown')
                    synth_tc = [{'id': tc_id, 'type': 'function', 'function': {'name': tc_name, 'arguments': '{}'}}]
                    offset = sum(1 for sid, _ in synthesized if sid < i)
                    synthesized.append((i + offset, make_assistant(synth_tc)))
                    repairs += 1

        # ── Pass 3: 删除空 assistant ──
        removed = 0
        for i in range(n):
            if is_empty_assistant(msgs[i]):
                keep[i] = False
                removed += 1

        # ── 应用修改 ──
        if synthesized:
            synthesized.sort(key=lambda x: x[0], reverse=True)
            for idx, msg in synthesized:
                msgs.insert(idx, msg)
                keep.insert(idx, True)

        new_msgs = [msgs[i] for i in range(len(msgs)) if keep[i]]

        if repairs > 0 or removed > 0:
            rel = os.path.relpath(path, BASE)
            with open(path, 'w', encoding='utf-8') as fh:
                for m in new_msgs:
                    if m:
                        fh.write(json.dumps(m, ensure_ascii=False) + '\n')
            fixed += 1
            total_repaired += repairs
            total_removed += removed
            desc = []
            if repairs: desc.append(f'+{repairs} repaired')
            if removed: desc.append(f'-{removed} removed')
            print(f'{rel}: {n} msgs -> {", ".join(desc)}')

print(f'\nDone: {fixed} files, {total_repaired} repaired, {total_removed} removed')
