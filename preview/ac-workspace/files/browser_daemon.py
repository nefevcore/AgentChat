"""浏览器守护进程 — 通过 stdin/stdout JSON 与 Node 工具通信"""
import json, sys, re, time, os
from pathlib import Path

# 强制 UTF-8，解决 Windows 下 Node 读取管道乱码
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")

TZ = __import__("datetime").timezone(__import__("datetime").timedelta(hours=8))
SCREENSHOT_DIR = Path(__file__).parent.parent / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

def output(data):
    """输出 JSON 行，限制大小防管道阻塞"""
    try:
        s = json.dumps(data, ensure_ascii=False)
        # 单行太长会撑爆 Node 缓冲区，截断 text 字段
        if len(s) > 8000 and isinstance(data.get("text"), str):
            data["text"] = data["text"][:4000] + "...(truncated)"
            s = json.dumps(data, ensure_ascii=False)
        sys.stdout.write(s + "\n")
        sys.stdout.flush()
    except Exception:
        # 兜底：纯 ASCII
        safe = {k: str(v)[:200] for k, v in data.items()}
        sys.stdout.write(json.dumps(safe) + "\n")
        sys.stdout.flush()

def sanitize(text):
    if not text: return ""
    patterns = [
        (r"<script[\s>].*?</script>", ""),
        (r"<iframe[\s>].*?</iframe>", ""),
        (r"\beval\s*\(", "[BLOCKED]("),
        (r"data:text/html", "[BLOCKED]"),
    ]
    for p, r in patterns:
        text = re.sub(p, r, text, flags=re.IGNORECASE | re.DOTALL)
    return text

def clean_text(page):
    raw = page.evaluate("""() => {
        const b = document.body; if (!b) return '';
        const c = b.cloneNode(true);
        c.querySelectorAll('script,style,noscript,svg,iframe,object,embed').forEach(e=>e.remove());
        return c.innerText.replace(/\\n{3,}/g,'\\n\\n').trim();
    }""")
    return sanitize(raw)

def main():
    from playwright.sync_api import sync_playwright

    output({"status": "starting", "message": "browser daemon booting..."})

    pw = sync_playwright().start()
    browser = pw.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    )
    context = browser.new_context(
        viewport={"width": 1280, "height": 720},
        permissions=[],
    )
    page = context.new_page()

    output({"status": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            output({"status": "error", "message": "invalid json"})
            continue

        action = cmd.get("action", "")

        try:
            if action == "open":
                url = cmd["url"]
                if not url.startswith("http"):
                    url = "https://" + url
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                try:
                    page.wait_for_load_state("networkidle", timeout=8000)
                except:
                    pass
                output({"status": "ok", "url": page.url, "title": page.title()})

            elif action == "click":
                page.click(cmd["selector"], timeout=10000)
                output({"status": "ok", "url": page.url})

            elif action == "type":
                sel = cmd["selector"]
                txt = cmd.get("text", "")
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.fill(txt, timeout=10000)
                else:
                    page.evaluate(
                        "({s,t})=>{const e=document.querySelector(s);if(!e)return;e.value=t;e.dispatchEvent(new Event('input',{bubbles:true}));}",
                        {"s": sel, "t": txt}
                    )
                output({"status": "ok"})

            elif action == "press":
                page.keyboard.press(cmd["key"])
                output({"status": "ok"})

            elif action == "content":
                text = clean_text(page)[:5000]
                output({
                    "status": "ok",
                    "url": page.url,
                    "title": page.title(),
                    "text": text,
                    "length": len(text),
                })

            elif action == "screenshot":
                name = cmd.get("name", f"shot_{int(time.time())}.png")
                path = SCREENSHOT_DIR / name
                page.screenshot(path=str(path), full_page=True)
                output({"status": "ok", "file": str(path)})

            elif action == "eval":
                result = page.evaluate(cmd["js"])
                output({"status": "ok", "result": str(result)[:2000]})

            elif action == "html":
                output({"status": "ok", "html_length": len(page.content())})

            elif action == "close":
                output({"status": "bye"})
                break

            else:
                output({"status": "error", "message": f"unknown action: {action}"})

        except Exception as e:
            output({"status": "error", "message": str(e)[:500]})

    # 清理
    context.close()
    browser.close()
    pw.stop()

if __name__ == "__main__":
    main()
