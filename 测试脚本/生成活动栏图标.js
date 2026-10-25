/**
 * 从 UCanTransit-logo.svg 派生活动栏图标。
 *
 * 只做三件事，形状一点不动：
 * 1) 画布缩到 24×24（viewBox 保持原样，等比缩放），整体内缩 6% 留出边距
 * 2) 两种填充色统一换成 currentColor，跟随主题
 * 3) 去掉生成器注释
 *
 * 运行：node 测试脚本/生成活动栏图标.js
 * 输出：media/icon.svg
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = path.join(root, "UCanTransit-logo.svg");
const target = path.join(root, "media", "icon.svg");

const raw = fs.readFileSync(source, "utf8");

const styled = raw
	.replace(/<!--[\s\S]*?-->/g, "")
	.replace(/\swidth="564"/, ' width="24"')
	.replace(/\sheight="564"/, ' height="24"')
	.replace(/fill="#e7e8ed"/gi, 'fill="currentColor"')
	.replace(/fill="#fbb430"/gi, 'fill="currentColor"')
	.trim();

// 原图是满画布的，24px 下会顶到边；包一层等比内缩，形状本身不变
const openTag = /^<svg[^>]*>/.exec(styled)?.[0];
if (!openTag) {
	throw new Error("没找到 <svg> 开始标签");
}
const inner = styled.slice(openTag.length).replace(/<\/svg>\s*$/, "");
const out = `${openTag}<g transform="translate(33.84 33.84) scale(0.88)">${inner}</g></svg>`;

const before = (raw.match(/<path/g) ?? []).length;
const after = (out.match(/<path/g) ?? []).length;
if (before !== after) {
	throw new Error(`路径数量对不上：原图 ${before} 条，产出 ${after} 条`);
}
if (!out.includes("currentColor")) {
	throw new Error("产出里没有 currentColor，填充色替换失败");
}

fs.writeFileSync(target, `${out}\n`, "utf8");
console.log(`已写出 media/icon.svg：${out.length} 字节，${after} 条路径`);

