import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class El {
	constructor(tag, opts = {}) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.attrs = {};
		this.listeners = new Map();
		this.classList = new Set();
		this._text = '';
		this.disabled = false;
		this.style = { setProperty() {} };
		if (opts.cls) for (const name of String(opts.cls).split(/\s+/)) if (name) this.classList.add(name);
	}
	get className() { return [...this.classList].join(' '); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	set textContent(value) { this._text = String(value); this.children = []; }
	setText(value) { this.textContent = value; }
	addClass(...names) { for (const name of names) for (const part of String(name).split(/\s+/)) if (part) this.classList.add(part); }
	toggleClass(name, force) {
		const on = force === undefined ? !this.classList.has(name) : Boolean(force);
		if (on) this.classList.add(name);
		else this.classList.delete(name);
	}
	hasClass(name) { return this.classList.has(name); }
	setAttribute(key, value) { this.attrs[key] = String(value); }
	getAttribute(key) { return this.attrs[key] ?? null; }
	createEl(tag, opts = {}) {
		const child = new El(tag, opts);
		if (opts.text !== undefined) child.textContent = opts.text;
		child.parent = this;
		this.children.push(child);
		return child;
	}
	createDiv(opts = {}) { return this.createEl('div', opts); }
	createSpan(opts = {}) { return this.createEl('span', opts); }
	addEventListener(name, callback) {
		const list = this.listeners.get(name) ?? [];
		list.push(callback);
		this.listeners.set(name, list);
	}
	fire(name, event = {}) {
		for (const callback of this.listeners.get(name) ?? []) callback({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
	}
	get parentElement() { return this.parent; }
	*descendants() {
		for (const child of this.children) {
			yield child;
			yield* child.descendants();
		}
	}
	querySelectorAll(selector) {
		return [...this.descendants()].filter((element) => matches(element, selector));
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function matches(element, selector) {
	// 支持 .class 与复合选择器 .class[attr]（dashboard 用它定位带 data-tab 的卡片）。
	if (/^[a-z]+$/i.test(selector)) return element.tagName === selector.toUpperCase();
	const parts = selector.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g);
	if (!parts) return false;
	return parts.every((part) => {
		if (part.startsWith('.')) return element.hasClass(part.slice(1));
		const key = part.slice(1, -1);
		// dataset 属性名去掉 data- 前缀：[data-tab] 对应 dataset.tab。
		const name = key.split('=')[0].replace(/^data-/, '');
		return Object.prototype.hasOwnProperty.call(element.dataset, name);
	});
}

globalThis.El = El;
globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} };

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class App {}
export class Modal {}
export const setIcon = () => {};
`;

const bundle = await build({
	stdin: {
		contents: `
			export { renderOverview } from './src/cleanup/cleanup-dashboard.ts';
			export { TFile } from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});

const { renderOverview, TFile } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function makeView(overrides = {}) {
	const activateTabCalls = [];
	return {
		contentEl: new El('div'),
		app: {},
		candidates: {
			images: [],
			attachments: [],
			brokenLinks: [],
			nativeLinks: [],
			brokenNoteLinks: [],
			wikiLinks: [],
			emptyFiles: [],
			folders: [],
			duplicates: [],
			convertibleImages: [],
		},
		activeTab: 'overview',
		scanning: false,
		hasScanned: false,
		showHelp: false,
		scanStages: [{ label: '读取文件' }, { label: '检查链接' }],
		scanProgress: { stage: 0, processed: 0, total: 1 },
		scanElapsedMs: 0,
		scannedTabs: new Set(),
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		conversion: { estimating: false, converting: false },
		...overrides,
		activateTab(tab) { activateTabCalls.push(tab); },
		__activateTabCalls: activateTabCalls,
	};
}

function emptyText(view) {
	const node = view.contentEl.querySelector('.orphan-cleanup-dashboard-empty');
	return node ? node.textContent : null;
}

test('尚未扫描任何分类时空态提示开始扫描，而不是声称干净', () => {
	const view = makeView();
	renderOverview(view);

	assert.equal(emptyText(view), '还没有扫描结果，点击「开始扫描」检查资料库。');
	assert.ok(view.contentEl.querySelector('.orphan-cleanup-dashboard-empty').hasClass('is-idle'));
});

test('全部分类已扫描且无问题时空态提示干净', () => {
	const categories = ['images', 'attachments', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links', 'empty-files', 'folders', 'duplicates'];
	const view = makeView({ scannedTabs: new Set(categories), hasScanned: true });
	renderOverview(view);

	assert.equal(emptyText(view), '所有已检查分类都很干净。');
	assert.equal(view.contentEl.querySelector('.orphan-cleanup-dashboard-empty').hasClass('is-idle'), false);
});

test('扫描进行中容器声明 aria-busy 与扫描中状态', () => {
	const view = makeView({ scanning: true });
	renderOverview(view);

	assert.equal(view.contentEl.querySelector('.orphan-cleanup-home').attrs['aria-busy'], 'true');
	const statuses = view.contentEl.querySelectorAll('.orphan-cleanup-dashboard-item-status');
	// 9 个扫描分类 + 图片转换卡片（扫描中归入优先处理区，提示等待估算）。
	assert.equal(statuses.length, 10, '扫描中仍需渲染全部分类卡片与转换卡片');
	assert.ok(statuses.every((status) => ['正在扫描…', '等待扫描', '已完成', '等待估算'].some((label) => status.textContent.includes(label))));
});

test('首页大数字在无数据时为 0 而不是留空', () => {
	const view = makeView();
	renderOverview(view);

	assert.equal(view.contentEl.querySelector('.orphan-cleanup-dashboard-total').textContent, '0');
});

function conversionCard(view) {
	return view.contentEl.querySelectorAll('.orphan-cleanup-dashboard-item').find((item) => item.dataset.tab === 'image-convert');
}

test('有可转换图片时首页出现图片转换卡片且计数正确', () => {
	const view = makeView({ candidates: { images: [], attachments: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], emptyFiles: [], folders: [], duplicates: [], convertibleImages: ['a.png', 'b.png', 'c.png'] } });
	renderOverview(view);

	const card = conversionCard(view);
	assert.ok(card, '首页应有图片转换卡片');
	const count = card.querySelector('.orphan-cleanup-dashboard-item-count');
	assert.equal(count.textContent, '3');
	// 有候选时归入优先处理组，而不是待检查组。
	assert.ok(card.parentElement.hasClass('orphan-cleanup-priority-grid'));
});

test('图片转换卡片点击进入 image-convert 页签', () => {
	const view = makeView({ candidates: { images: [], attachments: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], emptyFiles: [], folders: [], duplicates: [], convertibleImages: ['a.png'] } });
	renderOverview(view);

	const card = conversionCard(view);
	card.fire('click');
	assert.deepEqual(view.__activateTabCalls, ['image-convert']);
});

test('没有可转换图片且未估算时图片转换卡片归入待检查组', () => {
	const view = makeView({ scannedTabs: new Set(['images']) });
	renderOverview(view);

	const card = conversionCard(view);
	assert.ok(card, '未估算时首页仍应显示图片转换入口');
	assert.ok(card.parentElement.hasClass('orphan-cleanup-healthy-list'), '未估算的转换卡片应出现在待检查/复核组');
	assert.equal(card.querySelector('.orphan-cleanup-dashboard-item-status').textContent, '尚未估算');
});

test('首页待处理总数包含可转换图片数', () => {
	const view = makeView({
		candidates: { images: [], attachments: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], emptyFiles: ['e.md'], folders: [], duplicates: [], convertibleImages: ['a.png', 'b.png'] },
		scannedTabs: new Set(['images', 'attachments', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links', 'empty-files', 'folders', 'duplicates', 'image-convert']),
	});
	renderOverview(view);

	// 1 个空文件 + 2 张可转换 = 3。
	assert.equal(view.contentEl.querySelector('.orphan-cleanup-dashboard-total').textContent, '3');
});
