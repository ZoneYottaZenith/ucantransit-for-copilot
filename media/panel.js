const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const ui = {
	enabled: $("enabled"),
	subtitle: $("subtitle"),
	newSite: $("newSite"),
	removeSite: $("removeSite"),
	toggleSite: $("toggleSite"),
	siteSelect: $("siteSelect"),
	siteName: $("siteName"),
	siteNameHint: $("siteNameHint"),
	baseUrl: $("baseUrl"),
	urlHint: $("urlHint"),
	apiKey: $("apiKey"),
	toggleKey: $("toggleKey"),
	keyHint: $("keyHint"),
	connect: $("connect"),
	badge: $("badge"),
	meta: $("meta"),
	search: $("search"),
	modelList: $("modelList"),
	empty: $("empty"),
	selectAll: $("selectAll"),
	selectNone: $("selectNone"),
	rescan: $("rescan"),
	openSettings: $("openSettings"),
	clear: $("clear"),
	toasts: $("toasts"),
};

/** 下拉里显示的协议名称，按用户指定的写法。 */
const PROTOCOL_LABELS = {
	openai: "Chat Completions",
	"openai-responses": "Responses",
	anthropic: "Anthropic Messages",
	gemini: "Gemini",
};

const PROTOCOL_TITLES = {
	openai: "OpenAI Chat Completions，最通用，兼容性最好",
	"openai-responses": "OpenAI Responses，GPT 新代与 o 系列的原生形态",
	anthropic: "Anthropic Messages，Claude 原生形态",
	gemini: "Gemini 原生，generateContent",
};

const DEFAULT_URL_HINT = "填到 /v1 即可，模型列表路径会自动补全。";
const DEFAULT_KEY_HINT = "密钥存在系统密钥库，不写进设置文件。";

let state = null;
let keyword = "";
let addingNew = false;
let lastStatus = null;
let lastMessage = "";
/** 上一次渲染的站点，用来判断是不是刚切了站点 */
let lastSiteId = null;

const send = (message) => vscode.postMessage(message);

function toast(text, kind = "info") {
	if (!text) {
		return;
	}
	const el = document.createElement("div");
	el.className = `toast ${kind}`;
	el.textContent = text;
	ui.toasts.appendChild(el);
	requestAnimationFrame(() => el.classList.add("show"));
	setTimeout(() => {
		el.classList.remove("show");
		setTimeout(() => el.remove(), 220);
	}, 2600);
}

function contextLabel(length) {
	if (!length) {
		return "未知上下文";
	}
	if (length >= 1000 * 1000) {
		const value = length / (1000 * 1000);
		return `${Number.isInteger(value) ? value : value.toFixed(1)}M 上下文`;
	}
	return `${Math.round(length / 1000)}K 上下文`;
}

function formatTime(timestamp) {
	if (!timestamp) {
		return "";
	}
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function makeTag(text, className) {
	const span = document.createElement("span");
	span.className = className ? `tag ${className}` : "tag";
	span.textContent = text;
	return span;
}

/**
 * 切换站点后，把跟着变了的那几块淡入一次。
 * 只动透明度和位移，不碰布局和滚动位置。
 */
function playSiteSwap() {
	const blocks = document.querySelectorAll(".wrap > .card, .wrap > .models");
	blocks.forEach((block) => {
		block.classList.remove("site-swap");
		void block.offsetWidth; // 强制重排，让同名动画能重播
		block.classList.add("site-swap");
	});
}

function renderSites(sites, activeId) {
	ui.siteSelect.replaceChildren();
	if (sites.length === 0) {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "还没有站点，先填地址和 Key";
		ui.siteSelect.appendChild(option);
		ui.siteSelect.disabled = true;
		ui.removeSite.disabled = true;
		ui.toggleSite.disabled = true;
		ui.toggleSite.textContent = "停用";
		return;
	}
	sites.forEach((site, index) => {
		const option = document.createElement("option");
		option.value = site.id;
		// 序号按列表顺序走：先加的在前，删掉中间一个后面的自动顶上；只出现在这个下拉里
		const order = index + 1;
		// 原生 option 没法单独上色，用圆点符号当状态灯：绿=启用，白=停用
		const dot = site.enabled === false ? "⚪" : "🟢";
		option.textContent =
			site.enabled === false ? `${order}. ${site.name}${dot}（已停用）` : `${order}. ${site.name}${dot}`;
		option.title = site.baseUrl;
		option.selected = site.id === activeId;
		ui.siteSelect.appendChild(option);
	});
	ui.siteSelect.disabled = false;
	ui.removeSite.disabled = false;
	const active = sites.find((site) => site.id === activeId);
	ui.toggleSite.disabled = !active;
	ui.toggleSite.textContent = active && active.enabled === false ? "启用" : "停用";
}

/**
 * 档位套用：中转站自己改了模型 id 时，档位匹配不上，允许从本站其他模型借一份。
 *
 * 返回两个节点：head 里的小按钮，以及行下方点开才展开的单选面板。
 * 没有候选可借、也没手动设过时返回 null，不占地方。
 */
function buildEffortBlock(model, allModels) {
	const current = Array.isArray(model.supportedEfforts) ? model.supportedEfforts : [];
	const currentKey = current.join("/");
	const candidates = [];
	const seen = new Set();
	for (const item of allModels) {
		if (item.id === model.id) {
			continue;
		}
		const efforts = Array.isArray(item.supportedEfforts) ? item.supportedEfforts : [];
		if (efforts.length === 0) {
			continue;
		}
		const key = efforts.join("/");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		candidates.push({ efforts, sourceId: item.id, sourceName: item.name || item.id });
	}
	// 上游已经给了档位就不用再挂按钮；只有没档位、或之前手动套用过（要改回/清除）才显示
	const needsPicker = current.length === 0 || model.effortManual === true;
	if (candidates.length === 0 || !needsPicker) {
		return null;
	}

	const button = document.createElement("button");
	button.type = "button";
	button.className = "chip-btn effort-btn";
	button.textContent = current.length > 0 ? "改档位" : "设档位";
	button.title = "套用本站其他模型的思考档位";

	const panel = document.createElement("div");
	panel.className = "effort-panel";
	panel.hidden = true;

	button.addEventListener("click", (event) => {
		event.preventDefault();
		panel.hidden = !panel.hidden;
		button.textContent = panel.hidden ? (current.length > 0 ? "改档位" : "设档位") : "收起";
	});

	const groupName = `effort-${model.id}`;
	const markActive = () => {
		for (const option of panel.querySelectorAll(".effort-option")) {
			option.classList.toggle("active", option.querySelector("input").checked);
		}
	};

	for (const candidate of candidates) {
		const option = document.createElement("label");
		option.className = "effort-option";

		const radio = document.createElement("input");
		radio.type = "radio";
		radio.name = groupName;
		// 当前生效的就是这一组，打开时就勾上
		radio.checked = currentKey !== "" && candidate.efforts.join("/") === currentKey;
		if (radio.checked) {
			option.classList.add("active");
		}
		radio.addEventListener("change", () => {
			markActive();
			send({ type: "setModelEfforts", modelId: model.id, sourceModelId: candidate.sourceId });
			toast(`${model.id} 套用了 ${candidate.efforts.join("/")} 档位`, "success");
		});

		const label = document.createElement("span");
		label.className = "effort-option-text";
		label.textContent = candidate.efforts.join(" / ");
		const source = document.createElement("span");
		source.className = "effort-source";
		source.textContent = `来自 ${candidate.sourceName}`;
		option.append(radio, label, source);

		panel.appendChild(option);
	}

	if (model.effortManual === true) {
		const reset = document.createElement("label");
		reset.className = "effort-option reset";

		const radio = document.createElement("input");
		radio.type = "radio";
		radio.name = groupName;
		radio.addEventListener("change", () => {
			markActive();
			send({ type: "setModelEfforts", modelId: model.id, sourceModelId: null });
			toast(`${model.id} 已恢复自动识别的档位`);
		});

		const text = document.createElement("span");
		text.className = "effort-option-text";
		text.textContent = "恢复自动识别";
		reset.append(radio, text);
		panel.appendChild(reset);

		if (!currentKey) {
			radio.checked = true;
			reset.classList.add("active");
		}
	}

	return { button, panel };
}

function renderModels(models) {
	ui.modelList.replaceChildren();
	const visible = models.filter(
		(model) => !keyword || model.id.toLowerCase().includes(keyword.toLowerCase())
	);

	if (models.length === 0) {
		ui.empty.textContent = "填好地址和 Key，点上面的按钮开始读取。";
		ui.empty.style.display = "block";
	} else if (visible.length === 0) {
		ui.empty.textContent = "没有匹配的模型";
		ui.empty.style.display = "block";
	} else {
		ui.empty.style.display = "none";
	}

	for (const model of visible) {
		const item = document.createElement("li");
		item.className = "model";

		const head = document.createElement("div");
		head.className = "model-head";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "model-check";
		checkbox.checked = model.enabled !== false;
		checkbox.title = checkbox.checked ? "已注入 Copilot" : "已停用";
		checkbox.addEventListener("change", () => {
			send({ type: "toggleModel", modelId: model.id, enabled: checkbox.checked });
			toast(`${model.id} ${checkbox.checked ? "已启用" : "已停用"}`);
		});

		const id = document.createElement("span");
		id.className = "model-id";
		id.textContent = model.id;
		id.title = model.id;

		const protocol = document.createElement("select");
		protocol.className = "model-protocol";
		protocol.title = "这个模型的请求协议，选错会在发送失败时自动换回 Chat";
		for (const [value, label] of Object.entries(PROTOCOL_LABELS)) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			option.title = PROTOCOL_TITLES[value];
			protocol.appendChild(option);
		}
		protocol.value = PROTOCOL_LABELS[model.apiMode] ? model.apiMode : "openai";
		protocol.addEventListener("change", () => {
			send({ type: "setModelProtocol", modelId: model.id, apiMode: protocol.value });
			toast(`${model.id} 改用 ${PROTOCOL_LABELS[protocol.value]} 协议`);
		});

		const effort = buildEffortBlock(model, models);

		head.append(checkbox, id);
		if (effort) {
			head.append(effort.button);
		}
		head.append(protocol);
		item.appendChild(head);

		const body = document.createElement("div");
		body.className = "model-body";
		body.appendChild(makeTag(contextLabel(model.contextLength), "ctx"));
		if (model.toolCalling) {
			body.appendChild(makeTag("工具"));
		}
		if (model.vision) {
			body.appendChild(makeTag("图片"));
		}
		if (model.reasoning) {
			body.appendChild(makeTag("推理"));
		}
		if (model.supportedEfforts && model.supportedEfforts.length) {
			body.appendChild(
				makeTag(`档位 ${model.supportedEfforts.join("/")}${model.effortManual === true ? " (手动)" : ""}`, model.effortManual === true ? "manual" : "")
			);
		}
		if (model.source !== "models.dev") {
			body.appendChild(makeTag(model.source === "heuristic" ? "按名称推断" : "默认值", "unknown"));
		}
		// 对话时被上游拒过的参数，之后就不发了；刷新模型列表会重新尝试
		if (model.thinkingUnsupported || model.toolUnsupported) {
			const blocked = [model.thinkingUnsupported ? "思考" : "", model.toolUnsupported ? "工具" : ""]
				.filter(Boolean)
				.join("/");
			body.appendChild(makeTag(`线路拒绝${blocked}参数`, "unknown"));
		}
		item.appendChild(body);

		if (effort) {
			item.appendChild(effort.panel);
		}

		ui.modelList.appendChild(item);
	}
}

function render(next) {
	const previousStatus = lastStatus;
	lastStatus = next.status;
	// 站点切了就淡入一次，让内容不是硬切；首次渲染不播
	const siteChanged = lastSiteId !== null && lastSiteId !== next.activeSiteId;
	lastSiteId = next.activeSiteId;
	state = next;

	// 只有真正建成了才退出「新增中」；失败就留着，
	// 否则会把上一个站点的「已保存 xxx」又顶回来
	if (previousStatus === "scanning" && next.status === "ready") {
		addingNew = false;
	}

	ui.enabled.checked = next.enabled;
	if (document.activeElement !== ui.siteName) {
		ui.siteName.value = next.siteName || "";
	}
	ui.siteNameHint.textContent = addingNew
		? "新站点的名字，留空就用域名。"
		: "只是备注，用来区分多个中转站。";
	if (document.activeElement !== ui.baseUrl) {
		ui.baseUrl.value = next.baseUrl || "";
	}
	ui.subtitle.textContent = next.thinkingSupported
		? "把中转站模型接进 Copilot"
		: "把中转站模型接进 Copilot（当前版本不显示思考过程）";

	ui.apiKey.placeholder = !addingNew && next.hasApiKey ? `已保存 ${next.apiKeyHint}` : "sk-...";
	ui.keyHint.textContent = addingNew
		? "新站点的密钥会单独保存。"
		: next.hasApiKey
			? `当前密钥：${next.apiKeyHint}，重新填写可覆盖。`
			: DEFAULT_KEY_HINT;
	ui.urlHint.textContent = addingNew
		? "填新中转站的地址，连接后会自动建一个站点。"
		: DEFAULT_URL_HINT;

	const scanning = next.status === "scanning";
	ui.connect.disabled = scanning;
	ui.connect.textContent = scanning ? "读取中…" : addingNew ? "添加并读取模型" : "连接并读取模型";
	ui.rescan.disabled = scanning || !next.baseUrl;
	ui.selectAll.disabled = scanning || next.models.length === 0;
	ui.selectNone.disabled = scanning || next.models.length === 0;

	let badgeText = "未配置";
	let badgeClass = "";
	const enabledCount = next.models.filter((model) => model.enabled !== false).length;
	if (next.status === "error") {
		badgeText = "出错";
		badgeClass = "error";
	} else if (scanning) {
		badgeText = "读取中";
	} else if (!next.enabled) {
		badgeText = "已关闭";
	} else if (next.hasApiKey && enabledCount > 0) {
		badgeText = "已注入 Copilot";
		badgeClass = "on";
	} else if (next.hasApiKey) {
		badgeText = "待读取";
	}
	ui.badge.textContent = badgeText;
	ui.badge.className = `badge ${badgeClass}`.trim();

	const meta = [];
	if (next.models.length > 0) {
		meta.push(`${enabledCount}/${next.models.length} 启用`);
	}
	if (next.lastScanAt) {
		meta.push(`读取于 ${formatTime(next.lastScanAt)}`);
	}
	ui.meta.textContent = meta.join(" · ");

	// 后端给的说明只在变化时弹一下，不常驻占版面
	if (next.message && next.message !== lastMessage) {
		lastMessage = next.message;
		toast(next.message, next.status === "error" ? "error" : "info");
	}

	const scroller = document.scrollingElement;
	const scrollTop = scroller ? scroller.scrollTop : 0;
	renderSites(next.sites, next.activeSiteId);
	renderModels(next.models);
	if (siteChanged) {
		playSiteSwap();
	}
	if (scroller) {
		scroller.scrollTop = scrollTop;
	}
}

ui.connect.addEventListener("click", () => {
	const baseUrl = ui.baseUrl.value.trim();
	if (!baseUrl) {
		ui.baseUrl.focus();
		toast("先填一下中转站地址", "error");
		return;
	}
	ui.connect.disabled = true;
	ui.connect.textContent = "读取中…";
	// 同一个结果再来一次也要弹提示，所以先清掉去重标记
	lastMessage = "";
	send({
		type: "connect",
		baseUrl,
		apiKey: ui.apiKey.value.trim(),
		siteName: ui.siteName.value.trim(),
		// 告诉后端这是「新增」：地址和当前站点一样也要建新站点
		asNew: addingNew,
	});
});

// 改名不用重扫模型：失焦或回车就单独发一条消息
function commitSiteName() {
	if (!state || !state.activeSiteId || addingNew) {
		return;
	}
	const name = ui.siteName.value.trim();
	if (name === (state.siteName || "")) {
		return;
	}
	send({ type: "renameSite", siteId: state.activeSiteId, name });
}

ui.siteName.addEventListener("blur", commitSiteName);
ui.siteName.addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		ui.siteName.blur();
	}
});

ui.newSite.addEventListener("click", () => {
	addingNew = true;
	ui.siteName.value = "";
	ui.baseUrl.value = "";
	ui.apiKey.value = "";
	ui.baseUrl.focus();
	ui.connect.textContent = "添加并读取模型";
	ui.siteNameHint.textContent = "新站点的名字，留空就用域名。";
	ui.urlHint.textContent = "填新中转站的地址，连接后会自动建一个站点。";
	ui.keyHint.textContent = "新站点的密钥会单独保存。";
	ui.apiKey.placeholder = "sk-...";
	// 进入新建态时淡入一次，跟切站点用同一套过渡
	playSiteSwap();
	toast("填好地址和 Key，点下面的按钮就会新增一个站点");
});

ui.rescan.addEventListener("click", () => {
	lastMessage = "";
	send({ type: "rescan" });
});

ui.enabled.addEventListener("change", () =>
	send({ type: "setEnabled", enabled: ui.enabled.checked })
);

ui.siteSelect.addEventListener("change", () => {
	addingNew = false;
	send({ type: "selectSite", siteId: ui.siteSelect.value });
});

ui.removeSite.addEventListener("click", () => {
	if (ui.siteSelect.value) {
		send({ type: "removeSite", siteId: ui.siteSelect.value });
	}
});

ui.toggleSite.addEventListener("click", () => {
	const siteId = ui.siteSelect.value;
	const site = (state?.sites ?? []).find((item) => item.id === siteId);
	if (!site) {
		return;
	}
	// 按钮文案是“当前状态的反面”：显示“停用”就发 false
	send({ type: "setSiteEnabled", siteId, enabled: site.enabled === false });
});

ui.search.addEventListener("input", () => {
	keyword = ui.search.value.trim();
	if (state) {
		renderModels(state.models);
	}
});

ui.selectAll.addEventListener("click", () => {
	if (!state || state.models.length === 0) {
		return;
	}
	send({ type: "setAllModels", enabled: true });
	toast(`已启用全部 ${state.models.length} 个模型`);
});

ui.selectNone.addEventListener("click", () => {
	if (!state || state.models.length === 0) {
		return;
	}
	send({ type: "setAllModels", enabled: false });
	toast(`已停用全部 ${state.models.length} 个模型，Copilot 里只会保留开启的`);
});

ui.toggleKey.addEventListener("click", () => {
	const showing = ui.apiKey.type === "text";
	ui.apiKey.type = showing ? "password" : "text";
	ui.toggleKey.textContent = showing ? "显示" : "隐藏";
});

ui.clear.addEventListener("click", () => send({ type: "clear" }));
ui.openSettings.addEventListener("click", () => send({ type: "openSettings" }));

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message && message.type === "state") {
		render(message.state);
	}
});

send({ type: "ready" });
