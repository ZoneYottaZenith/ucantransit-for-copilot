/**
 * 生成市场主图用的 SVG。
 *
 * 原来的 logo 是浅灰（#e7e8ed）配橙，放在白色背景的市场页面上几乎看不见。
 * 这里只做配色和背景，形状一条 path 都不改：
 * 1) 垫一个深色直角底，白底和深底两套主题下都有对比度
 * 2) 浅灰部分换成接近白的 #F2F3F5
 * 3) 橙色 #FBB430 原样保留
 * 4) 整体内缩 8%，免得图形顶到圆角边
 *
 * 运行：node 测试脚本/生成主图.js
 * 输出：测试脚本/图标预览/主图-新.svg
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = path.join(root, "UCanTransit-logo.svg");
const target = path.join(root, "测试脚本", "图标预览", "主图-新.svg");

const BACKGROUND = "#24262B";
const LIGHT = "#F2F3F5";

const raw = fs.readFileSync(source, "utf8");

const inner = raw
	.replace(/<!--[\s\S]*?-->/g, "")
	.replace(/^[\s\S]*?<svg[^>]*>/, "")
	.replace(/<\/svg>\s*$/, "")
	.replace(/fill="#e7e8ed"/gi, `fill="${LIGHT}"`)
	.replace(/data-color-layer="#e7e8ed"/gi, `data-color-layer="${LIGHT}"`)
	.trim();

const before = (raw.match(/<path/g) ?? []).length;
const after = (inner.match(/<path/g) ?? []).length;
if (before !== after) {
	throw new Error(`路径数量对不上：原图 ${before} 条，产出 ${after} 条`);
}
if (inner.includes("#e7e8ed")) {
	throw new Error("浅灰还没换干净");
}

const svg = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="564" height="564" viewBox="0 0 564 564" version="1.1">',
	`<rect x="0" y="0" width="564" height="564" fill="${BACKGROUND}"/>`,
	`<g transform="translate(45.12 45.12) scale(0.84)">${inner}</g>`,
	"</svg>",
	"",
].join("\n");

fs.writeFileSync(target, svg, "utf8");
console.log(`已写出 ${path.relative(root, target)}：${svg.length} 字节，${after} 条路径`);
