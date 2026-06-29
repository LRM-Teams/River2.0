import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

const DEFAULT_TIMEOUT_MS = 30_000;
const SNAPSHOT_TEXT_LIMIT = 12_000;
const SELECTOR_WAIT_STATE = "visible" as const;

const navigateSchema = Type.Object({
	url: Type.String({ description: "URL to open" }),
	headless: Type.Optional(
		Type.Boolean({ description: "Launch headless. Defaults to true unless PI_PLAYWRIGHT_HEADFUL=1." }),
	),
	executablePath: Type.Optional(Type.String({ description: "Optional path to a local Chrome/Chromium executable" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Navigation timeout in milliseconds" })),
});

const snapshotSchema = Type.Object({
	selector: Type.Optional(Type.String({ description: "Optional CSS selector to scope the snapshot" })),
});

const clickSchema = Type.Object({
	selector: Type.Optional(Type.String({ description: "CSS selector for the target element" })),
	text: Type.Optional(Type.String({ description: "Visible text to click when selector is not provided" })),
	doubleClick: Type.Optional(Type.Boolean({ description: "Double click instead of single click" })),
	button: Type.Optional(Type.String({ description: "Mouse button: left, right, or middle" })),
});

const typeSchema = Type.Object({
	selector: Type.String({ description: "CSS selector for an input, textarea, or contenteditable element" }),
	text: Type.String({ description: "Text to type or fill" }),
	submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
	slowly: Type.Optional(
		Type.Boolean({ description: "Type characters with a small delay instead of filling instantly" }),
	),
});

const pressKeySchema = Type.Object({
	key: Type.String({ description: "Keyboard key to press, for example Enter, Escape, ArrowDown" }),
});

const waitForSchema = Type.Object({
	selector: Type.Optional(Type.String({ description: "CSS selector to wait until visible" })),
	text: Type.Optional(Type.String({ description: "Visible text to wait for" })),
	textGone: Type.Optional(Type.String({ description: "Visible text to wait to disappear" })),
	timeMs: Type.Optional(Type.Number({ description: "Milliseconds to wait" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
});

const evaluateSchema = Type.Object({
	function: Type.String({ description: "JavaScript function string, for example () => document.title" }),
	selector: Type.Optional(
		Type.String({ description: "Optional selector. When present, function receives the element." }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum evaluation time in milliseconds" })),
});

const screenshotSchema = Type.Object({
	filename: Type.Optional(
		Type.String({ description: "Optional file name inside the temporary screenshot directory" }),
	),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
	selector: Type.Optional(Type.String({ description: "Optional element selector to screenshot" })),
});

type NavigateParams = Static<typeof navigateSchema>;
type SnapshotParams = Static<typeof snapshotSchema>;
type ClickParams = Static<typeof clickSchema>;
type TypeParams = Static<typeof typeSchema>;
type PressKeyParams = Static<typeof pressKeySchema>;
type WaitForParams = Static<typeof waitForSchema>;
type EvaluateParams = Static<typeof evaluateSchema>;
type ScreenshotParams = Static<typeof screenshotSchema>;

interface BrowserState {
	browser?: Browser;
	context?: BrowserContext;
	page?: Page;
	headless?: boolean;
	executablePath?: string;
}

interface ElementSummary {
	index: number;
	tag: string;
	text: string;
	selector: string;
	href?: string;
	placeholder?: string;
	role?: string;
}

interface SnapshotElement {
	tagName: string;
	id: string;
	textContent: string | null;
	getAttribute(name: string): string | null;
	innerText?: string;
	value?: string;
	ariaLabel?: string | null;
	name?: string;
	placeholder?: string;
	href?: string;
}

const state: BrowserState = {};

function getHeadless(value: boolean | undefined): boolean {
	return value ?? process.env.PI_PLAYWRIGHT_HEADFUL !== "1";
}

async function getPage(params?: Pick<NavigateParams, "headless" | "executablePath">): Promise<Page> {
	const headless = getHeadless(params?.headless);
	const executablePath = params?.executablePath;
	const mustRelaunch =
		!state.browser || state.headless !== headless || (state.executablePath ?? "") !== (executablePath ?? "");
	if (mustRelaunch) {
		await closeBrowser();
		state.browser = await chromium.launch({ headless, executablePath });
		state.context = await state.browser.newContext({ viewport: { width: 1280, height: 900 } });
		state.page = await state.context.newPage();
		state.headless = headless;
		state.executablePath = executablePath;
	}
	if (!state.page) {
		state.page = await state.context?.newPage();
	}
	if (!state.page) throw new Error("Failed to create Playwright page");
	return state.page;
}

async function requirePage(): Promise<Page> {
	if (state.page && !state.page.isClosed()) return state.page;
	throw new Error("No browser page is open. Call browser_navigate first.");
}

async function closeBrowser(): Promise<void> {
	await state.browser?.close().catch(() => undefined);
	state.browser = undefined;
	state.context = undefined;
	state.page = undefined;
	state.headless = undefined;
	state.executablePath = undefined;
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function normalizeButton(button: string | undefined): "left" | "right" | "middle" {
	if (button === "right" || button === "middle") return button;
	return "left";
}

function trimText(value: string, limit: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}\n...[truncated]` : value;
}

async function makeSnapshot(page: Page, params: SnapshotParams): Promise<string> {
	const root = params.selector ? page.locator(params.selector).first() : page.locator("body");
	await root.waitFor({ state: "attached", timeout: DEFAULT_TIMEOUT_MS });
	const text = truncate(trimText(await root.innerText().catch(() => ""), SNAPSHOT_TEXT_LIMIT), SNAPSHOT_TEXT_LIMIT);
	const elements = await root
		.locator("a,button,input,textarea,select,[role=button],[contenteditable=true]")
		.evaluateAll((nodes) =>
			nodes.slice(0, 80).map((node, index) => {
				const element = node as unknown as SnapshotElement;
				const tag = element.tagName.toLowerCase();
				const escapedId = element.id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
				const id = element.id ? `#${escapedId}` : "";
				const name = element.name ? `[name="${element.name.replaceAll('"', '\\"')}"]` : "";
				const selector = id || `${tag}${name}${index > 0 ? ` >> nth=${index}` : ""}`;
				return {
					index,
					tag,
					text: (element.innerText || element.value || element.ariaLabel || "").replace(/\s+/g, " ").trim(),
					selector,
					href: element.href || undefined,
					placeholder: element.placeholder || undefined,
					role: element.getAttribute("role") || undefined,
				};
			}),
		)
		.catch((): ElementSummary[] => []);
	return formatJson({ url: page.url(), title: await page.title(), text, elements });
}

async function locatorFromClickParams(page: Page, params: ClickParams) {
	if (params.selector) return page.locator(params.selector).first();
	if (params.text) return page.getByText(params.text, { exact: false }).first();
	throw new Error("browser_click requires either selector or text");
}

const browserNavigateTool = defineTool({
	name: "browser_navigate",
	label: "browser_navigate",
	description:
		"Open a URL in a persistent Playwright Chromium page. If browser launch fails, tell the user to run `npx playwright install chromium` or `npx playwright install --with-deps chromium`.",
	promptSnippet: "Open a URL in a Playwright Chromium browser",
	promptGuidelines: [
		"Use browser_navigate before other browser_* tools when no page is open.",
		"If browser_navigate reports missing browser binaries or system libraries, tell the user to run `npx playwright install chromium` or `npx playwright install --with-deps chromium`.",
	],
	parameters: navigateSchema,
	async execute(_toolCallId, params: NavigateParams) {
		try {
			const page = await getPage(params);
			await page.goto(params.url, {
				waitUntil: "domcontentloaded",
				timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			});
			await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
			return {
				content: [{ type: "text", text: `Opened ${page.url()}\nTitle: ${await page.title()}` }],
				details: undefined,
			};
		} catch (error) {
			throw new Error(
				`${String(error)}\n\nInstall browser support with: npx playwright install chromium\nOn fresh Linux/container systems: npx playwright install --with-deps chromium`,
			);
		}
	},
});

const browserSnapshotTool = defineTool({
	name: "browser_snapshot",
	label: "browser_snapshot",
	description: "Capture a structured snapshot of the current page text and common interactive elements.",
	promptSnippet: "Inspect the current browser page",
	parameters: snapshotSchema,
	async execute(_toolCallId, params: SnapshotParams) {
		const page = await requirePage();
		return { content: [{ type: "text", text: await makeSnapshot(page, params) }], details: undefined };
	},
});

const browserClickTool = defineTool({
	name: "browser_click",
	label: "browser_click",
	description: "Click an element on the current page by CSS selector or visible text.",
	promptSnippet: "Click an element in the browser",
	parameters: clickSchema,
	async execute(_toolCallId, params: ClickParams) {
		const page = await requirePage();
		const locator = await locatorFromClickParams(page, params);
		await locator.waitFor({ state: SELECTOR_WAIT_STATE, timeout: DEFAULT_TIMEOUT_MS });
		if (params.doubleClick) {
			await locator.dblclick({ button: normalizeButton(params.button) });
		} else {
			await locator.click({ button: normalizeButton(params.button) });
		}
		await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
		return { content: [{ type: "text", text: `Clicked ${params.selector ?? params.text}` }], details: undefined };
	},
});

const browserTypeTool = defineTool({
	name: "browser_type",
	label: "browser_type",
	description: "Fill or type into an input, textarea, or contenteditable element on the current page.",
	promptSnippet: "Type into a browser element",
	parameters: typeSchema,
	async execute(_toolCallId, params: TypeParams) {
		const page = await requirePage();
		const locator = page.locator(params.selector).first();
		await locator.waitFor({ state: SELECTOR_WAIT_STATE, timeout: DEFAULT_TIMEOUT_MS });
		if (params.slowly) {
			await locator.click();
			await page.keyboard.type(params.text, { delay: 35 });
		} else {
			await locator.fill(params.text);
		}
		if (params.submit) await page.keyboard.press("Enter");
		return { content: [{ type: "text", text: `Typed into ${params.selector}` }], details: undefined };
	},
});

const browserPressKeyTool = defineTool({
	name: "browser_press_key",
	label: "browser_press_key",
	description: "Press a keyboard key in the current browser page.",
	promptSnippet: "Press a browser keyboard key",
	parameters: pressKeySchema,
	async execute(_toolCallId, params: PressKeyParams) {
		const page = await requirePage();
		await page.keyboard.press(params.key);
		return { content: [{ type: "text", text: `Pressed ${params.key}` }], details: undefined };
	},
});

const browserWaitForTool = defineTool({
	name: "browser_wait_for",
	label: "browser_wait_for",
	description: "Wait for time, visible text, text disappearance, or a visible CSS selector on the current page.",
	promptSnippet: "Wait for browser state",
	parameters: waitForSchema,
	async execute(_toolCallId, params: WaitForParams) {
		const page = await requirePage();
		const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (params.timeMs !== undefined) await page.waitForTimeout(params.timeMs);
		if (params.selector) await page.locator(params.selector).first().waitFor({ state: SELECTOR_WAIT_STATE, timeout });
		if (params.text)
			await page.getByText(params.text, { exact: false }).first().waitFor({ state: SELECTOR_WAIT_STATE, timeout });
		if (params.textGone)
			await page.getByText(params.textGone, { exact: false }).first().waitFor({ state: "hidden", timeout });
		return { content: [{ type: "text", text: "Wait completed" }], details: undefined };
	},
});

const browserEvaluateTool = defineTool({
	name: "browser_evaluate",
	label: "browser_evaluate",
	description: "Run a JavaScript function on the current page, optionally against a selected element.",
	promptSnippet: "Evaluate JavaScript in the browser",
	parameters: evaluateSchema,
	async execute(_toolCallId, params: EvaluateParams) {
		const page = await requirePage();
		page.setDefaultTimeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const value = params.selector
			? await page.locator(params.selector).first().evaluate(params.function)
			: await page.evaluate(params.function);
		return { content: [{ type: "text", text: formatJson(value) }], details: undefined };
	},
});

const browserScreenshotTool = defineTool({
	name: "browser_screenshot",
	label: "browser_screenshot",
	description: "Save a screenshot of the current page or a selected element to a temporary file.",
	promptSnippet: "Capture a browser screenshot",
	parameters: screenshotSchema,
	async execute(_toolCallId, params: ScreenshotParams) {
		const page = await requirePage();
		const dir = join(tmpdir(), "pi-playwright-screenshots");
		await mkdir(dir, { recursive: true });
		const filename = params.filename ?? `screenshot-${Date.now()}.png`;
		const filePath = join(dir, filename);
		if (params.selector) {
			await page.locator(params.selector).first().screenshot({ path: filePath });
		} else {
			await page.screenshot({ path: filePath, fullPage: params.fullPage });
		}
		return { content: [{ type: "text", text: `Screenshot saved to ${filePath}` }], details: { path: filePath } };
	},
});

const browserCloseTool = defineTool({
	name: "browser_close",
	label: "browser_close",
	description: "Close the Playwright browser session.",
	parameters: Type.Object({}),
	async execute() {
		await closeBrowser();
		return { content: [{ type: "text", text: "Browser closed" }], details: undefined };
	},
});

export default function piPlaywright(pi: ExtensionAPI): void {
	pi.registerTool(browserNavigateTool);
	pi.registerTool(browserSnapshotTool);
	pi.registerTool(browserClickTool);
	pi.registerTool(browserTypeTool);
	pi.registerTool(browserPressKeyTool);
	pi.registerTool(browserWaitForTool);
	pi.registerTool(browserEvaluateTool);
	pi.registerTool(browserScreenshotTool);
	pi.registerTool(browserCloseTool);

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("pi-playwright", "Playwright enabled");
	});

	pi.on("session_shutdown", async () => {
		await closeBrowser();
	});
}
