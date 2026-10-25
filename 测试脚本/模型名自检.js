/**
 * 模型展示名自检：确认 id 只做大小写整理，语义和顺序都不动。
 *
 * 运行：node 测试脚本/模型名自检.js
 */

const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return {};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const { displayNameOf } = require(path.join(outDir, "displayName.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

const cases = [
	["gpt-5.5", "GPT-5.5"],
	["gpt-4o-mini", "GPT-4o-Mini"],
	["gpt-3.5-turbo", "GPT-3.5-Turbo"],
	["o3-mini", "O3-Mini"],
	["deepseek-v3", "DeepSeek-V3"],
	["deepseek-r1", "DeepSeek-R1"],
	["deepseek-chat", "DeepSeek-Chat"],
	["claude-sonnet-4", "Claude-Sonnet-4"],
	["claude-3-opus", "Claude-3-Opus"],
	["gemini-2.5-pro", "Gemini-2.5-Pro"],
	["gemma-3-27b-it", "Gemma-3-27b-IT"],
	["qwen-max", "Qwen-Max"],
	["qwen2.5-vl-72b", "Qwen2.5-VL-72b"],
	["glm-4v", "GLM-4v"],
	["openai/gpt-4o", "OpenAI/GPT-4o"],
	["anthropic/claude-3.5-sonnet", "Anthropic/Claude-3.5-Sonnet"],
	["google/gemini-2.0-flash", "Google/Gemini-2.0-Flash"],
	["llava:latest", "Llava:Latest"],
	["my-custom-model", "My-Custom-Model"],
	["MODEL-IN-CAPS", "MODEL-IN-CAPS"],
];

for (const [input, expected] of cases) {
	const actual = displayNameOf(input);
	check(`${input} → ${expected}`, actual === expected, actual);
}

// id 本身不能被改动：去掉大小写差异后必须与原值一致
for (const [input] of cases) {
	const actual = displayNameOf(input);
	check(
		`${input} 的字符没有被增删`,
		actual.toLowerCase() === input.toLowerCase(),
		actual
	);
}

check("空字符串安全", displayNameOf("") === "");
check("首尾空白去掉", displayNameOf("  gpt-5.5  ") === "GPT-5.5");

for (const item of results) {
	const detail = item.detail === undefined ? "" : `  -> ${JSON.stringify(item.detail)}`;
	console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${detail}`);
}
const passed = results.filter((item) => item.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exitCode = passed === results.length ? 0 : 1;
