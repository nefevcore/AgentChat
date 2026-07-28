#!/usr/bin/env python3
"""
清理所有会话 JSONL 文件中的脏数据：
- 悬空 assistant(tool_calls)（缺少 tool 结果）
- 孤儿 tool 消息（tool_call_id 不匹配任何活跃 assistant）
- 空 assistant 消息（无 content、无 tool_calls、无 reasoning_content）

用法：python scripts/clean-sessions.py
"""
import os, json, sys

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'workspace', 'default', 'sessions')
if not os.path.isdir(BASE):
    BASE = os.path.join(os.getcwd(), 'workspace', 'default', 'sessions')

fixed = 0
total_removed = 0

for root, dirs, files in os.walk(BASE):
    for f in files:
        if f != 'messages.jsonl':
            continue
        path = os.path.join(root, f)

        try:
            with open(path, 'r', encoding='utf-8-sig') as fh:
                raw = fh.read()
        except Exception as e:
            print(f'[SKIP] {os.path.relpath(path, BASE)}: {e}')
            continue

        # 解析 JSONL：先按行分割，再处理行内可能存在的多对象合并
        msgs = []
        import re
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

        def is_assistant(m):
            if not m: return False
            r = m.get('role', '')
            return (r in ('assistant', 'agent')) and bool(m.get('tool_calls'))

        # Pass 1: remove dangling assistant(tool_calls) + partial tool results
        for i in range(n):
            m = msgs[i]
            if not is_assistant(m):
                continue
            tc = m.get('tool_calls')
            if not tc:
                continue
            found = 0
            for j in range(i + 1, n):
                nxt = msgs[j]
                if nxt and nxt.get('role') == 'tool':
                    found += 1
                elif nxt and nxt.get('role') == 'error':
                    continue
                else:
                    break
            if found < len(tc):
                keep[i] = False
                removed = 0
                for j in range(i + 1, n):
                    nxt = msgs[j]
                    if nxt and nxt.get('role') == 'tool' and removed < found:
                        keep[j] = False
                        removed += 1
                    elif nxt and nxt.get('role') == 'error':
                        continue
                    else:
                        break

        # Pass 2: remove orphaned tools (tool_call_id not in active assistant)
        active_ids = set()
        for i in range(n):
            m = msgs[i]
            if not m:
                continue
            if is_assistant(m):
                active_ids = set(tc['id'] for tc in m['tool_calls'])
            elif m.get('role') not in ('tool', 'error'):
                active_ids = set()
            if m.get('role') == 'tool' and keep[i]:
                if m.get('tool_call_id', '') not in active_ids:
                    keep[i] = False

        # Pass 3: remove empty assistants (agent or old assistant role)
        for i in range(n):
            m = msgs[i]
            if not m:
                continue
            r = m.get('role', '')
            if (r in ('assistant', 'agent')
                    and not m.get('content')
                    and not m.get('tool_calls')
                    and not m.get('reasoning_content')):
                keep[i] = False

        new_msgs = [msgs[i] for i in range(n) if keep[i]]
        removed = n - len(new_msgs)
        if removed > 0:
            with open(path, 'w', encoding='utf-8') as fh:
                for m in new_msgs:
                    if m:
                        fh.write(json.dumps(m, ensure_ascii=False) + '\n')
            fixed += 1
            total_removed += removed
            print(f'{os.path.relpath(path, BASE)}: {n} -> {len(new_msgs)} (-{removed})')

print(f'\nDone: {fixed} files, {total_removed} messages removed')
