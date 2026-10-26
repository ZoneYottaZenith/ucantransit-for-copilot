/**
 * HTTP 公共层：超时、重试、SSE / NDJSON 行解析。
 * 所有协议共用，避免各写一套。
 */

// 只对限流重试。5xx 直接交给调用方报错：重发流式 POST 只会让用户多等一轮，
// 上游那边也可能已经收过一遍请求了。
const RETRYABLE_STATUS = new Set([429]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 800;

export interface FetchOptions {
	url: string;
	init: RequestInit;
	/** 首次响应超时（毫秒）。不传或 <= 0 表示不限，取消交给调用方的 signal。 */
	timeoutMs?: number;
	/** 传入后由调用方控制取消。 */
	signal?: AbortSignal;
	/** 是否对 429/5xx 做退避重试。 */
	retry?: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("请求已取消"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function fetchWithRetry(options: FetchOptions): Promise<Response> {
	const attempts = options.retry === false ? 1 : MAX_ATTEMPTS;
	let lastError: unknown;

	for (let attempt = 0; attempt < attempts; attempt++) {
		// 已经取消过的话 abort 事件不会再发一遍，这里得当场停下，否则请求照样发出去
		if (options.signal?.aborted) {
			throw new Error("请求已取消");
		}
		const controller = new AbortController();
		const forwardAbort = () => controller.abort();
		options.signal?.addEventListener("abort", forwardAbort, { once: true });
		const limitMs = options.timeoutMs ?? 0;
		const timer = limitMs > 0 ? setTimeout(() => controller.abort(), limitMs) : undefined;

		try {
			const response = await fetch(options.url, { ...options.init, signal: controller.signal });
			if (timer) {
				clearTimeout(timer);
			}
			options.signal?.removeEventListener("abort", forwardAbort);

			if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
				const retryAfter = Number(response.headers.get("retry-after"));
				const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** attempt;
				await sleep(Math.min(wait, 10_000), options.signal);
				continue;
			}
			return response;
		} catch (error) {
			if (timer) {
				clearTimeout(timer);
			}
			options.signal?.removeEventListener("abort", forwardAbort);
			if (options.signal?.aborted) {
				throw new Error("请求已取消");
			}
			lastError = error;
			if (attempt < attempts - 1) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
				continue;
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error("请求失败");
}

/** 逐行读取响应体（SSE 与 NDJSON 都能用）。 */
export async function readLines(
	body: ReadableStream<Uint8Array>,
	onLine: (line: string) => void
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				onLine(line.trim());
			}
		}
		if (buffer.trim()) {
			onLine(buffer.trim());
		}
	} finally {
		// 中断或异常退出时把流收掉，否则 socket 会一直挂着
		try {
			await reader.cancel();
		} catch {
			// 流已经结束或已经出错，忽略即可
		}
		reader.releaseLock();
	}
}

/** 从 `data: {...}` 行里取出 JSON；不是数据行返回 undefined。 */
export function parseSseData(line: string): Record<string, unknown> | undefined {
	if (!line.startsWith("data:")) {
		return undefined;
	}
	const payload = line.slice(5).trim();
	if (!payload || payload === "[DONE]") {
		return undefined;
	}
	try {
		const value = JSON.parse(payload);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function errorFromResponse(status: number, statusText: string, body: string): Error {
	const detail = body.trim().slice(0, 400);
	const hint = statusHint(status);
	const head = `上游返回 ${status} ${statusText}`;
	const tail = detail ? `：${detail}` : "";
	return new Error(hint ? `${head}，${hint}${tail}` : `${head}${tail}`);
}

/** 状态码对应的处置建议，带用户下一步该干什么。 */
function statusHint(status: number): string | undefined {
	switch (status) {
		case 400:
			return "请求被上游拒绝，可能是模型名、参数或协议不匹配";
		case 401:
			return "API Key 无效或已过期，打开 UCanTransit 面板重新填写";
		case 402:
			return "账户余额不足，去中转站后台充值";
		case 403:
			return "没有访问权限，检查这把 Key 的模型权限或地区限制";
		case 404:
			return "接口路径不存在，检查地址是否需要带 /v1，或这家线路没有这个模型";
		case 413:
			return "请求体过大，精简上下文或减少图片";
		case 429:
			return "触发限流，稍等再试或降低并发";
		default:
			if (status >= 500) {
				return "上游服务或网关异常，稍后重试或查看中转站状态页";
			}
			return undefined;
	}
}

/**
 * 把 Node / undici 的常见错误码翻成人话。
 *
 * 网络层失败时原始信息基本只是 `fetch failed`，用户看不出该查 DNS、
 * 防火墙还是代理，这里给它一句能直接照着做的提示。
 */
const NETWORK_HINTS: Array<{ pattern: RegExp; hint: string }> = [
	{ pattern: /ENOTFOUND|EAI_AGAIN|ENODATA|ESERVFAIL/i, hint: "域名解析失败，检查地址拼写或本机 DNS" },
	{
		pattern: /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL/i,
		hint: "连不上这个地址，检查端口、防火墙或是否需要走代理",
	},
	{
		pattern: /ECONNRESET|ECONNABORTED|EPIPE|UND_ERR_SOCKET|\bEOF\b/i,
		hint: "连接被中途断开，多为网络不稳或上游主动断流，可直接重试",
	},
	{
		pattern: /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError/i,
		hint: "连接超时，检查网络或代理设置",
	},
	{
		pattern: /CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i,
		hint: "证书校验失败，检查系统时间或代理是否做了证书替换",
	},
	{
		pattern: /UND_ERR_HEADERS_OVERFLOW|UND_ERR_RESPONSE|HTTPParserError/i,
		hint: "上游响应不合规，可能是这家中转站的实现有问题",
	},
	{ pattern: /ERR_INVALID_URL/i, hint: "接口地址不合法，检查是否漏了 https:// 或多了空格" },
];

export function describeNetworkError(error: unknown): string | undefined {
	const record = error as
		| { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } }
		| undefined;
	const code = String(record?.code ?? record?.cause?.code ?? record?.name ?? "");
	const message = typeof record?.message === "string" ? record.message : "";
	const probe = `${code} ${message}`;
	for (const item of NETWORK_HINTS) {
		if (item.pattern.test(probe)) {
			return item.hint;
		}
	}
	return undefined;
}
