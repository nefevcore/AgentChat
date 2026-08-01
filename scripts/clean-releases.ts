/**
 * clean-releases.ts —— 清理 GitHub Release body，每个 release 只保留对应版本的 changelog
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxx
 *   npx tsx scripts/clean-releases.ts
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const CHANGELOG = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf-8");
const REPO = "nefevcore/AgentChat";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
    console.error("❌ 请设置 GITHUB_TOKEN 环境变量");
    process.exit(1);
}

// 解析 CHANGELOG，提取每个版本的段落
function parseChangelog(text: string): Map<string, string> {
    const sections = new Map<string, string>();
    // 匹配 ## [X.Y.Z] ... 直到下一个 ## [...] 或文件末尾
    const regex = /^## \[(\d+\.\d+\.\d+)\].*?(?=^## \[|\Z)/gms;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const version = match[1];
        const body = match[0].trim();
        sections.set(version, body);
    }
    return sections;
}

async function api(path: string, method = "GET", body?: string) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
}

async function main() {
    const sections = parseChangelog(CHANGELOG);
    console.log(`📋 解析到 ${sections.size} 个版本的 changelog:`);
    for (const [v] of sections) console.log(`   v${v}`);

    // 获取所有 releases
    console.log("\n🔍 获取 GitHub releases...");
    const releases: any[] = await api("releases?per_page=30");
    console.log(`   找到 ${releases.length} 个 release`);

    let updated = 0;
    for (const rel of releases) {
        const tag = rel.tag_name; // e.g. "v0.3.2"
        const ver = tag.replace(/^v/, ""); // e.g. "0.3.2"

        const section = sections.get(ver);
        if (!section) {
            console.log(`⏭️  ${tag}: changelog 中无此版本，跳过`);
            continue;
        }

        // 检查是否需要更新（新的 body 比现有 body 短很多）
        const currentBody = rel.body || "";
        if (section === currentBody) {
            console.log(`✅ ${tag}: 已是最新，无需更新`);
            continue;
        }

        console.log(`🔄 ${tag}: 更新 release body (${currentBody.length} → ${section.length} 字符)`);

        await api(`releases/${rel.id}`, "PATCH", JSON.stringify({
            body: section,
        }));
        updated++;
    }

    console.log(`\n✅ 完成！更新了 ${updated} 个 release。`);
}

main().catch((e) => {
    console.error("❌ 错误:", e.message);
    process.exit(1);
});
