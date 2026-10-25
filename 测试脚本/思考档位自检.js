/**
 * 思考档位自检：验证模型选择器下拉的构造逻辑（直接跑 out/provider.js 里的真代码）
 *
 * 重点确认：
 * 1. “停用”只在 effortMandatory === false 时出现，其余情况一律不给
 * 2. 没有任何档位信息时干脆不生成下拉
 * 3. 中文环境给短标签和说明，非中文环境用上游原值
 * 4. default 一定落在枚举里
 * 5. 读取用户选择的顺序是 modelOptions 优先
 *
 * 运行：node 测试脚本/思考档位自检.js
 */

const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

// out 里的模块会 require("vscode")，只补齐这里用到的部分
const originalLoad = Module._load;
let uiLanguage = "zh-cn";
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return {
			env: {
				get language() {
					return uiLanguage;
				},
			},
			Uri: { joinPath: (base, ...parts) => path.join(base.fsPath ?? base, ...parts) },
			workspace: { fs: { readFile: async (target) => fs.promises.readFile(target) } },
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const { configurationSchema, reasoningEffortFrom } = require(path.join(outDir, "provider.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

function entry(patch) {
	return {
		id: "test-model",
		name: "test-model",
		contextLength: 128000,
		toolCalling: true,
		vision: false,
		reasoning: true,
		source: "models.dev",
		enabled: true,
		...patch,
	};
}

function schemaOf(patch) {
	return configurationSchema(entry(patch));
}

function authOf(schema) {
	return schema?.properties?.reasoningEffort;
}

function main() {
	// 1. 上游没表态强制与否：不给停用
	const unknown = authOf(schemaOf({ supportedEfforts: ["low", "high"] }));
	check("没声明可关闭时不提供停用", !unknown.enum.includes("none"), unknown.enum);

	// 2. 上游明确强制思考：不给停用
	const mandatory = authOf(schemaOf({ supportedEfforts: ["low", "high"], effortMandatory: true }));
	check("强制思考时不提供停用", !mandatory.enum.includes("none"), mandatory.enum);

	// 3. 上游明确可关闭：停用排第一
	const disableable = authOf(schemaOf({ supportedEfforts: ["low", "high"], effortMandatory: false }));
	check("可关闭时停用排第一", disableable.enum[0] === "none", disableable.enum);
	check("可关闭时不重复堆 none", disableable.enum.filter((item) => item === "none").length === 1, disableable.enum);

	// 4. 上游档位里本来就带 none：不重复
	const hasNone = authOf(schemaOf({ supportedEfforts: ["none", "low"], effortMandatory: false }));
	check("上游自带 none 时不重复", hasNone.enum.filter((item) => item === "none").length === 1, hasNone.enum);

	// 5. 没有档位信息：不生成下拉
	check("无档位信息不生成下拉", schemaOf({}) === undefined);
	check("空档位数组不生成下拉", schemaOf({ supportedEfforts: [] }) === undefined);

	// 6. 标签用英文首字母大写，说明留给悬停
	uiLanguage = "zh-cn";
	const zh = authOf(schemaOf({ supportedEfforts: ["low", "high", "max"], effortMandatory: false }));
	check("标题是思考模式", zh.title === "思考模式", zh.title);
	check("标签用英文首字母大写", zh.enumItemLabels.join(",") === "None,Low,High,Max", zh.enumItemLabels);
	check("xhigh 标签是 Xhigh", (() => {
		const odd = authOf(schemaOf({ supportedEfforts: ["xhigh"] }));
		return odd.enumItemLabels[0] === "Xhigh";
	})(), authOf(schemaOf({ supportedEfforts: ["xhigh"] })).enumItemLabels);
	check("每档都有说明", zh.enumDescriptions.length === zh.enum.length && zh.enumDescriptions.every(Boolean), zh.enumDescriptions);
	check("未知档位也首字母大写", (() => {
		const odd = authOf(schemaOf({ supportedEfforts: ["turbo"] }));
		return odd.enumItemLabels[0] === "Turbo";
	})());

	// 7. 从弱到强排序，不管上游给的是什么顺序
	const unordered = authOf(
		schemaOf({ supportedEfforts: ["max", "xhigh", "high", "medium", "low", "none"], effortMandatory: false })
	);
	check(
		"档位从弱到强排列",
		unordered.enum.join(",") === "none,low,medium,high,xhigh,max",
		unordered.enum
	);
	const partial = authOf(schemaOf({ supportedEfforts: ["high", "low", "minimal"] }));
	check("部分档位也按强度排", partial.enum.join(",") === "minimal,low,high", partial.enum);
	const unknownTail = authOf(schemaOf({ supportedEfforts: ["turbo", "low", "max"] }));
	check("认不出的档位排最后", unknownTail.enum.join(",") === "low,max,turbo", unknownTail.enum);

	// 8. 英文环境不显示中文标题
	uiLanguage = "en";
	const en = authOf(schemaOf({ supportedEfforts: ["low", "high"], effortMandatory: false }));
	check("英文环境同样用原值标签", en.enumItemLabels.join(",") === "None,Low,High", en.enumItemLabels);
	check("英文环境无中文标题", en.title === "Thinking", en.title);
	uiLanguage = "zh-cn";

	// 8. default 一定在枚举里
	check("default 落在枚举内", disableable.enum.includes(disableable.default), disableable.default);
	check("没指定默认档时不默认成停用", disableable.default !== "none", disableable.default);
	check("上游给了默认档就用它", (() => {
		const picked = authOf(schemaOf({ supportedEfforts: ["low", "high"], defaultEffort: "high", effortMandatory: false }));
		return picked.default === "high";
	})());
	check("default 非法时退回第一项", (() => {
		const bad = authOf(schemaOf({ supportedEfforts: ["low", "high"], defaultEffort: "ultra" }));
		return bad.default === "low";
	})());

	// 9. 读取顺序：modelOptions 最优先
	const fromModelOptions = reasoningEffortFrom({
		modelOptions: { reasoningEffort: "max" },
		modelConfiguration: { reasoningEffort: "low" },
		configuration: { reasoningEffort: "high" },
	});
	check("modelOptions 优先", fromModelOptions === "max", fromModelOptions);

	const fromConfiguration = reasoningEffortFrom({ modelConfiguration: { reasoningEffort: "low" } });
	check("没有 modelOptions 时读 modelConfiguration", fromConfiguration === "low", fromConfiguration);

	const empty = reasoningEffortFrom({});
	check("都没给时返回 undefined", empty === undefined, empty);

	const blank = reasoningEffortFrom({ modelOptions: { reasoningEffort: "   " } });
	check("空白值当没给", blank === undefined, blank);

	// 输出
	for (const item of results) {
		const detail = item.detail === undefined ? "" : `  -> ${JSON.stringify(item.detail)}`;
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${detail}`);
	}
	const passed = results.filter((item) => item.ok).length;
	console.log(`\n${passed}/${results.length} 通过`);
	process.exitCode = passed === results.length ? 0 : 1;
}

main();
