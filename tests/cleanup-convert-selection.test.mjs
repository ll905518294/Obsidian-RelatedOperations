import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.style = { width: '', setProperty() {} };
		this.className = '';
		this.attrs = {};
		this._text = '';
		this._listeners = [];
		this.disabled = false;
		this.checked = false;
		this.hidden = false;
		this.type = '';
		this.title = '';
		this.value = '';
		this.selected = false;
	}
	createDiv(options) { return this.createEl('div', options); }
	createSpan(options) { return this.createEl('span', options); }
	createEl(tag, options = {}) {
		const el = new El(tag);
		if (options.cls) el.className = options.cls;
		if (options.text !== undefined) el.setText(options.text);
		if (options.attr) for (const [key, value] of Object.entries(options.attr)) el.setAttribute(key, value);
		if (options.type !== undefined) el.type = options.type;
		if (options.value !== undefined) el.value = options.value;
		this.children.push(el);
		el.parent = this;
		return el;
	}
	setText(text) { this._text = String(text); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	get childNodes() { return this.children; }
	addClass(...names) { for (const name of names) if (!this.hasClass(name)) this.className = this.className ? `${this.className} ${name}` : name; }
	removeClass(name) { this.className = this.className.split(/\s+/).filter((item) => item && item !== name).join(' '); }
	hasClass(name) { return this.className.split(/\s+/).includes(name); }
	toggleClass(name, force) { const want = force === undefined ? !this.hasClass(name) : force; if (want) this.addClass(name); else this.removeClass(name); }
	setAttribute(key, value) { this.attrs[key] = String(value); }
	getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
	removeAttribute(key) { delete this.attrs[key]; }
	addEventListener(type, callback) { this._listeners.push({ type, callback }); }
	dispatch(type, event = {}) {
		for (const listener of [...this._listeners]) {
			if (listener.type === type) listener.callback({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
		}
	}
	appendChild(node) {
		if (node.parent) {
			const previous = node.parent.children.indexOf(node);
			if (previous >= 0) node.parent.children.splice(previous, 1);
		}
		this.children.push(node);
		node.parent = this;
	}
	remove() {
		if (!this.parent) return;
		const index = this.parent.children.indexOf(this);
		if (index >= 0) this.parent.children.splice(index, 1);
		this.parent = null;
	}
	empty() { this.children = []; this._text = ''; }
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
	querySelectorAll(selector) { return descendants(this).filter((el) => matches(el, selector)); }
}

function descendants(root) {
	const result = [];
	const visit = (node) => { for (const child of node.children) { result.push(child); visit(child); } };
	visit(root);
	return result;
}

function matches(el, selector) {
	if (selector.includes('input')) {
		if (el.tagName !== 'INPUT') return false;
		if (selector.includes('[type="checkbox"]') && el.type !== 'checkbox') return false;
		return true;
	}
	const last = selector.split(' ').pop();
	if (last.startsWith('.')) return el.hasClass(last.slice(1));
	return false;
}

function byTag(root, tag) { return descendants(root).filter((el) => el.tagName === tag.toUpperCase()); }
function byClass(root, cls) { return descendants(root).filter((el) => el.hasClass(cls)); }
function byText(root, tag, text) { return byTag(root, tag).filter((el) => el.textContent === text); }

const stub = `
export class TAbstractFile {}
export class TFile { constructor(path, extension) { this.path = path; this.extension = extension; } }
export class TFolder {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); Notice.messages.push(String(message)); } static messages = []; }
export const Platform = { isDesktopApp: false };
export const setIcon = () => {};
`;

const bundle = await build({
	stdin: {
			contents: `
				export { TFile } from 'obsidian';
			export { renderConversionList, updateConversionSelectionSummary, countCandidatesByFormat, initialVisibleRows, nextVisibleRows, clampQualityInput } from './src/cleanup/cleanup-list-convert.ts';
			export { renderConversionActions } from './src/cleanup/cleanup-list-convert-actions.ts';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-stub',
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});
const {
	TFile,
	renderConversionList,
	updateConversionSelectionSummary,
	renderConversionActions,
	countCandidatesByFormat,
	initialVisibleRows,
	nextVisibleRows,
	clampQualityInput,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeItem(patch) {
	return {
		path: 'pics/a.png',
		extension: 'png',
		width: 100,
		height: 80,
		oldBytes: 100,
		newBytes: 40,
		hasAlpha: false,
		referenceCount: 2,
		sourceNotePaths: [],
		...patch,
	};
}

function makeHost(items) {
	const conversion = {
		...{
			sources: ['png'],
			target: 'jpg',
			quality: 85,
			alpha: 'flatten',
		},
		config: { sources: ['png'], target: 'jpg', quality: 85, alpha: 'flatten' },
		items,
		estimating: false,
		estimateProgress: { processed: 0, total: items.length },
		converting: false,
		convertProgress: { processed: 0, total: 0 },
	};
	return {
		contentEl: new El('div'),
		activeTab: 'image-convert',
		app: {
			workspace: {
				openLinkText: async (path) => { (globalThis.__openedLinks ??= []).push(path); },
				getLeaf: () => ({ openFile: async (file) => { (globalThis.__openedLinks ??= []).push(file.path); } }),
			},
			vault: {
				getAbstractFileByPath: (path) => path.endsWith('.md') ? new TFile(path, 'md') : null,
			},
		},
		candidates: { convertibleImages: [] },
		conversion,
		selections: new Set(),
		convertSelections: new Set(),
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		async setConversionConfig() {},
		async estimateConversions() {},
		async convertSelected() {},
		renderContents() {},
	};
}

test('转换页勾选只写 convertSelections，不污染共享 selections', () => {
	const item = makeItem({ path: 'pics/a.png' });
	const host = makeHost([item]);
	renderConversionList(host);

	const checkbox = byTag(host.contentEl, 'input').find((input) => input.type === 'checkbox' && input.dataset.path === item.path);
	assert.ok(checkbox);
	checkbox.checked = true;
	checkbox.dispatch('change');

	assert.equal(host.selections.has(item.path), false);
	assert.equal(host.convertSelections.has(item.path), true);
	const references = byClass(host.contentEl, 'orphan-cleanup-convert-references')[0];
	assert.equal(references.textContent, '引用 2 处');
	assert.equal(byTag(references, 'button')[0].getAttribute('aria-label'), '打开引用此图片的笔记（2 处）');
});

test('全选可节省项排除 blocked 与增体积项', () => {
	const host = makeHost([
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
		makeItem({ path: 'pics/grow.png', oldBytes: 100, newBytes: 140 }),
		makeItem({ path: 'pics/blocked.png', oldBytes: 500, newBytes: 10, blockedReason: '目标文件已存在' }),
	]);
	renderConversionList(host);

	byText(host.contentEl, 'button', '全选可节省项')[0].dispatch('click');

	assert.deepEqual([...host.convertSelections], ['pics/save.png']);
	assert.equal(host.selections.size, 0);
	const saveCheckbox = byTag(host.contentEl, 'input').find((input) => input.dataset.path === 'pics/save.png');
	assert.equal(saveCheckbox.checked, true);
});

test('汇总条排除 blocked，并单独列出将跳过数量与原因', () => {
	const host = makeHost([
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
		makeItem({ path: 'pics/same.png', oldBytes: 100, newBytes: 100 }),
		makeItem({ path: 'pics/blocked.png', oldBytes: 500, newBytes: 10, blockedReason: '目标文件已存在' }),
	]);
	renderConversionList(host);

	const summary = byClass(host.contentEl, 'orphan-cleanup-convert-summary')[0];
	assert.match(summary.textContent, /候选 3 张 · 当前 200 B · 转换后约 140 B · 预计节省 60 B（30%）/);
	assert.match(summary.textContent, /另有 1 张将跳过（目标文件已存在）/);
});

test('转换结果以警告样式展示未能回滚的笔记与保留的新文件', () => {
	const host = makeHost([]);
	host.conversion.lastResult = {
		converted: 1,
		skipped: 0,
		failed: 1,
		savedBytes: 10,
		convertedItems: [],
		skippedItems: [],
		failedItems: [{ path: 'pics/a.png', reason: 'write-failed', reasonText: '改写引用失败' }],
		unrestored: ['notes/a.md'],
		keptNewFile: true,
		keptNewFilePath: 'pics/a.jpg',
	};
	renderConversionActions(host);

	const warnings = byClass(host.contentEl, 'orphan-cleanup-convert-unrestored');
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].hasClass('mod-warning'));
	assert.match(warnings[0].textContent, /notes\/a\.md/);
	assert.match(warnings[0].textContent, /需人工检查/);
	const kept = byClass(host.contentEl, 'orphan-cleanup-convert-kept-new-file');
	assert.equal(kept.length, 1);
	assert.ok(kept[0].hasClass('mod-warning'));
	assert.match(kept[0].textContent, /pics\/a\.jpg/);
	assert.match(byClass(host.contentEl, 'orphan-cleanup-convert-failure-text')[0].textContent, /原图已保留，部分笔记可能已改为新路径，见下方明细/);
});

test('转换进行中禁用配置控件，并把开始按钮改成转换中…', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	host.conversion.converting = true;
	renderConversionList(host);
	renderConversionActions(host);

	const inputs = byTag(host.contentEl, 'input');
	const source = inputs.find((input) => input.type === 'checkbox' && /^源格式 PNG，共 \d+ 张$/.test(input.getAttribute('aria-label')));
	assert.equal(source.disabled, true);
	const rowCheckbox = inputs.find((input) => input.type === 'checkbox' && input.dataset.path === 'pics/a.png');
	assert.equal(rowCheckbox.disabled, true);
	assert.equal(byTag(host.contentEl, 'select')[0].disabled, true);
	assert.equal(inputs.find((input) => input.type === 'number').disabled, true);
	const radios = inputs.filter((input) => input.type === 'radio');
	assert.equal(radios.length, 2);
	assert.ok(radios.every((radio) => radio.disabled));
	assert.equal(byText(host.contentEl, 'button', '扫描并估算')[0].disabled, true);
	assert.equal(byText(host.contentEl, 'button', '全选可节省项')[0].disabled, true);
	const start = byText(host.contentEl, 'button', '转换中…')[0];
	assert.ok(start);
	assert.equal(start.disabled, true);
});

test('转换进行中显示中止按钮并调用 abortConvert', () => {
	const host = makeHost([]);
	host.conversion.converting = true;
	let aborted = 0;
	host.abortConvert = () => { aborted += 1; };
	renderConversionList(host);
	renderConversionActions(host);

	const abort = byText(host.contentEl, 'button', '中止转换')[0];
	assert.ok(abort);
	abort.dispatch('click');

	assert.equal(aborted, 1);
	assert.equal(abort.disabled, true);
	assert.equal(abort.textContent, '正在中止…');
});

test('结果区展示中止标注与待重试移入回收站的数量', () => {
	const host = makeHost([]);
	host.conversion.lastResult = {
		converted: 1,
		skipped: 0,
		failed: 0,
		savedBytes: 10,
		convertedItems: [],
		skippedItems: [],
		failedItems: [],
		aborted: true,
		pendingTrash: [{ path: 'pics/a.png', newPath: 'pics/a.jpg' }],
	};
	renderConversionActions(host);

	const aborted = byClass(host.contentEl, 'orphan-cleanup-convert-aborted')[0];
	assert.ok(aborted);
	assert.ok(aborted.hasClass('mod-warning'));
	assert.equal(aborted.textContent, '已中止，已完成的部分保留');
	const pending = byClass(host.contentEl, 'orphan-cleanup-convert-pending-trash')[0];
	assert.ok(pending);
	assert.match(pending.textContent, /待重试：1 张（引用已更新，源图仍在）/);
	assert.match(pending.textContent, /再次执行同一选择即可只重试移入回收站/);
});

test('blockedReason 使用中文映射，未知值原样展示', () => {
	const host = makeHost([
		makeItem({ path: 'pics/alpha.png', blockedReason: 'alpha-skip' }),
		makeItem({ path: 'pics/excalidraw.png', blockedReason: 'code-block-reference' }),
		makeItem({ path: 'pics/css.png', blockedReason: 'css-url' }),
		makeItem({ path: 'pics/picture.png', blockedReason: 'html-source' }),
		makeItem({ path: 'pics/unknown.png', blockedReason: 'target-exists' }),
	]);
	renderConversionList(host);

	const summary = byClass(host.contentEl, 'orphan-cleanup-convert-summary')[0];
	assert.match(summary.textContent, /透明图按设置跳过/);
	assert.match(summary.textContent, /Excalidraw 代码块中的图片引用无法安全改写/);
	assert.match(summary.textContent, /CSS url\(\) 中的图片引用无法安全改写/);
	assert.match(summary.textContent, /picture\/source 中的图片引用无法安全改写/);
	assert.match(summary.textContent, /target-exists/);
	assert.doesNotMatch(summary.textContent, /undefined/);
	const statuses = byClass(host.contentEl, 'orphan-cleanup-convert-blocked-reason').map((item) => item.textContent);
	assert.ok(statuses.includes('跳过：透明图按设置跳过'));
	assert.ok(statuses.includes('跳过：target-exists'));
	assert.ok(statuses.every((text) => !text.includes('undefined')));

	host.conversion.lastResult = {
		converted: 0,
		skipped: 2,
		failed: 0,
		savedBytes: 0,
		convertedItems: [],
		skippedItems: [
			{ path: 'pics/old.png', reason: 'source-changed' },
			{ path: 'pics/residual.png', reason: 'residual-reference' },
		],
		failedItems: [],
	};
	renderConversionActions(host);

	const details = byClass(host.contentEl, 'orphan-cleanup-convert-details')[0];
	assert.match(details.textContent, /源文件在转换前已变化，已跳过/);
	assert.match(details.textContent, /改写后仍有残留引用，已跳过/);
	assert.doesNotMatch(details.textContent, /undefined/);
});

test('blocked 行不展示 0 × 0 与 −100%，改显示 — 与 跳过', () => {
	const host = makeHost([
		makeItem({ path: 'pics/has-size.png', width: 0, height: 0, oldBytes: 3300, newBytes: 0, referenceCount: 0, blockedReason: 'has-size' }),
	]);
	renderConversionList(host);

	const row = byClass(host.contentEl, 'orphan-cleanup-convert-row')[0];
	assert.doesNotMatch(row.textContent, /0 × 0/);
	assert.doesNotMatch(row.textContent, /−100%/);
	assert.match(row.textContent, /—/);
	assert.match(row.textContent, /跳过/);
	assert.match(row.textContent, /引用 0 处/);
});

test('转换进行中顶部卡片展示转换进度与张数', () => {
	const host = makeHost([]);
	host.conversion.converting = true;
	host.conversion.convertProgress = { processed: 3, total: 8, currentPath: 'pics/d.png' };
	renderConversionList(host);
	renderConversionActions(host);

	const progress = byClass(host.contentEl, 'orphan-cleanup-convert-progress')[0];
	assert.ok(progress, '转换中应渲染进度区域');
	assert.equal(progress.attrs['data-phase'], 'convert');
	assert.match(progress.textContent, /正在转换 3 \/ 8 · pics\/d\.png/);
});

test('估算进行中进度文案标记为估算阶段', () => {
	const host = makeHost([]);
	host.conversion.estimating = true;
	host.conversion.estimateProgress = { processed: 2, total: 5 };
	renderConversionList(host);

	const progress = byClass(host.contentEl, 'orphan-cleanup-convert-progress')[0];
	assert.ok(progress, '估算中应渲染进度区域');
	assert.equal(progress.attrs['data-phase'], 'estimate');
	assert.match(progress.textContent, /正在估算 2 \/ 5/);
});

test('行内徽标展示源格式到目标格式的转换方向', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png', extension: 'png' })]);
	renderConversionList(host);

	const badge = byClass(host.contentEl, 'orphan-cleanup-convert-format')[0];
	assert.ok(badge, '应渲染格式徽标');
	assert.match(badge.textContent, /PNG→JPG/);
});

test('未估算项显示待估算占位，不当作跳过或可节省', () => {
	const host = makeHost([
		makeItem({ path: 'pics/pending.png', newBytes: 0 }),
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
	]);
	renderConversionList(host);

	const rows = byClass(host.contentEl, 'orphan-cleanup-convert-row');
	const pendingRow = rows.find((row) => row.textContent.includes('pics/pending.png'));
	assert.ok(pendingRow);
	// 未估算：体积列用 …，变化列显示「待估算」，状态列显示「待估算」。
	assert.match(pendingRow.textContent, /100 B → …/);
	assert.match(pendingRow.textContent, /待估算/);
	// 不要误认为 0 字节就是跳过（-100%）或 0%。
	assert.doesNotMatch(pendingRow.textContent, /−100%/);
	assert.doesNotMatch(pendingRow.textContent, /跳过/);

	// 未估算项不进入节省量，也不被「全选可节省项」选中。
	assert.equal(byText(host.contentEl, 'button', '全选可节省项')[0].disabled, false);
	byText(host.contentEl, 'button', '全选可节省项')[0].dispatch('click');
	assert.deepEqual([...host.convertSelections], ['pics/save.png']);
});

test('汇总条把未估算项单列，不把它们算进当前/转换体积', () => {
	const host = makeHost([
		makeItem({ path: 'pics/pending.png', oldBytes: 100, newBytes: 0 }),
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
	]);
	renderConversionList(host);

	const summary = byClass(host.contentEl, 'orphan-cleanup-convert-summary')[0];
	assert.match(summary.textContent, /候选 2 张/);
	// 只有已估算项参与体积：当前 100 B、转换后 40 B、节省 60 B。
	assert.match(summary.textContent, /当前 100 B · 转换后约 40 B · 预计节省 60 B/);
	assert.match(summary.textContent, /1 张待估算/);
	assert.match(summary.textContent, /尚未估算/);
});

test('选中含未估算项时汇总条标注待估算张数', () => {
	const host = makeHost([
		makeItem({ path: 'pics/pending.png', oldBytes: 100, newBytes: 0 }),
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
	]);
	renderConversionList(host);
	host.convertSelections.add('pics/pending.png');
	host.convertSelections.add('pics/save.png');
	renderConversionActions(host);

	const summary = byClass(host.contentEl, 'orphan-cleanup-convert-selection-summary')[0];
	assert.ok(summary);
	assert.match(summary.textContent, /已选：2 张 · 预计节省 60 B（1 张待估算）/);
});

test('页面不再展示「此页会修改文件」重复横幅', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	renderConversionList(host);

	assert.equal(byClass(host.contentEl, 'orphan-cleanup-convert-warning').length, 0);
	assert.doesNotMatch(host.contentEl.textContent, /此页会修改文件/);
});

test('源格式统计候选数量：jpeg 归入 jpg，零项也显示', () => {
	assert.deepEqual(countCandidatesByFormat([
		{ extension: 'png' },
		{ extension: 'PNG' },
		{ extension: 'jpeg' },
		{ extension: 'jpg' },
		{ extension: 'webp' },
		{ extension: 'gif' },
	]), { png: 2, jpg: 2, webp: 1, bmp: 0, avif: 0 });

	const host = makeHost([]);
	host.candidates.convertibleImages = [
		{ path: 'a.png', extension: 'png' },
		{ path: 'b.jpeg', extension: 'jpeg' },
	];
	renderConversionList(host);

	const labels = byTag(host.contentEl, 'input')
		.filter((input) => input.type === 'checkbox')
		.map((input) => input.getAttribute('aria-label'))
		.filter((value) => Boolean(value) && value.startsWith('源格式'));
	assert.deepEqual(labels, [
		'源格式 PNG，共 1 张',
		'源格式 JPG，共 1 张',
		'源格式 WebP，共 0 张',
		'源格式 BMP，共 0 张',
		'源格式 AVIF，共 0 张',
	]);
	assert.match(host.contentEl.textContent, /PNG（1）/);
	assert.match(host.contentEl.textContent, /BMP（0）/);
});

test('顶部操作栏合并扫描、全选与候选统计', () => {
	const host = makeHost([
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
		makeItem({ path: 'pics/pending.png', oldBytes: 100, newBytes: 0 }),
	]);
	host.candidates.convertibleImages = host.conversion.items.map((item) => ({ path: item.path, extension: item.extension }));
	renderConversionList(host);

	const toolbar = byClass(host.contentEl, 'orphan-cleanup-convert-toolbar')[0];
	assert.ok(toolbar);
	assert.deepEqual(byTag(toolbar, 'button').map((button) => button.textContent), ['扫描并估算', '全选可节省项', '全部选择', '取消选择']);
	assert.equal(byClass(toolbar, 'orphan-cleanup-convert-toolbar-count')[0].textContent, '共 2 张候选 · 1 张可节省');
	// 统计信息只在操作栏出现一次，配置区不再重复。
	assert.equal(byClass(host.contentEl, 'orphan-cleanup-convert-toolbar-count').length, 1);
});

test('候选超过一页时按 200 张分页，显示更多只追加行', () => {
	const items = Array.from({ length: 450 }, (_, index) => makeItem({ path: `pics/${index}.png` }));
	const host = makeHost(items);
	renderConversionList(host);

	const rows = () => byClass(host.contentEl, 'orphan-cleanup-convert-row');
	const more = () => byClass(host.contentEl, 'orphan-cleanup-convert-more')[0];
	assert.equal(rows().length, 200);
	assert.equal(more().textContent, '显示更多（剩余 250 张）');

	more().dispatch('click');
	assert.equal(rows().length, 400);
	assert.equal(more().textContent, '显示更多（剩余 50 张）');

	more().dispatch('click');
	assert.equal(rows().length, 450);
	assert.equal(more().hidden, true);
});

test('分页边界：不足一页全部渲染，追加夹到总数', () => {
	assert.equal(initialVisibleRows(120), 120);
	assert.equal(initialVisibleRows(450), 200);
	assert.equal(initialVisibleRows(0), 0);
	assert.equal(nextVisibleRows(200, 450), 400);
	assert.equal(nextVisibleRows(400, 450), 450);
	assert.equal(nextVisibleRows(450, 450), 450);
	assert.equal(nextVisibleRows(0, 30), 30);
});

test('开始转换上移到顶部工具栏，不再有底部动作栏', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	renderConversionList(host);
	renderConversionActions(host);

	const toolbar = byClass(host.contentEl, 'orphan-cleanup-convert-toolbar')[0];
	const toolbarActions = byClass(host.contentEl, 'orphan-cleanup-convert-toolbar-actions')[0];
	const primary = byClass(host.contentEl, 'orphan-cleanup-convert-toolbar-primary')[0];
	assert.ok(toolbar);
	assert.ok(toolbarActions);
	assert.ok(primary);
	const start = byClass(host.contentEl, 'orphan-cleanup-convert-start')[0];
	assert.ok(start);
	assert.equal(start.parent, primary);
	assert.equal(byClass(host.contentEl, 'orphan-cleanup-convert-actions').length, 0);

	const summary = byClass(host.contentEl, 'orphan-cleanup-convert-selection-summary')[0];
	assert.ok(summary);
	assert.equal(summary.parent, primary);
	assert.equal(primary.parent, toolbar);
	assert.ok(toolbar.hasClass('orphan-cleanup-convert-toolbar'));
	// 右侧信息区顺序：候选统计 → 已选摘要 → 主操作按钮。
	const order = primary.children.map((child) => child.hasClass('orphan-cleanup-convert-toolbar-count')
		? 'count'
		: child.hasClass('orphan-cleanup-convert-selection-summary')
			? 'summary'
			: child.hasClass('orphan-cleanup-convert-start') ? 'start' : '');
	assert.deepEqual(order, ['count', 'summary', 'start']);
});

test('质量输入为数字框，范围 1–100 且不再使用滑块', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	renderConversionList(host);

	const quality = byClass(host.contentEl, 'orphan-cleanup-convert-quality-input')[0];
	assert.ok(quality);
	assert.equal(quality.type, 'number');
	assert.equal(quality.getAttribute('min'), '1');
	assert.equal(quality.getAttribute('max'), '100');
	assert.equal(quality.getAttribute('step'), '1');
	assert.equal(quality.value, '85');
	assert.equal(byTag(host.contentEl, 'input').filter((input) => input.type === 'range').length, 0);
	assert.match(byClass(host.contentEl, 'orphan-cleanup-convert-quality-info')[0].title, /100 = 最高质量/);

	assert.equal(clampQualityInput(''), 1);
	assert.equal(clampQualityInput('0'), 1);
	assert.equal(clampQualityInput('150'), 100);
	assert.equal(clampQualityInput('99.6'), 100);
	assert.equal(clampQualityInput('not-a-number'), 1);
});

test('质量输入 change 与 Enter 都提交夹取后的值', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	renderConversionList(host);
	const quality = byClass(host.contentEl, 'orphan-cleanup-convert-quality-input')[0];
	let patch;
	host.setConversionConfig = async (value) => { patch = value; };

	quality.value = '150';
	quality.dispatch('change');
	assert.equal(quality.value, '100');
	assert.deepEqual(patch, { quality: 100 });

	patch = undefined;
	quality.value = '';
	quality.dispatch('change');
	assert.equal(quality.value, '85', '清空后应恢复当前质量，而不是落到最低值');
	assert.equal(patch, undefined);

	quality.value = 'not-a-number';
	quality.dispatch('keydown', { key: 'Enter' });
	assert.equal(quality.value, '85');
	assert.equal(patch, undefined);

	quality.value = '0';
	quality.dispatch('change');
	assert.equal(quality.value, '1');
	assert.deepEqual(patch, { quality: 1 });

	patch = undefined;
	quality.value = '70';
	quality.dispatch('keydown', { key: 'a' });
	assert.equal(patch, undefined);
});

test('质量说明收进 info 图标，PNG 目标时提示质量不适用', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	renderConversionList(host);

	const quality = byClass(host.contentEl, 'orphan-cleanup-convert-quality-input')[0];
	assert.equal(quality.disabled, false);
	assert.equal(byClass(host.contentEl, 'orphan-cleanup-convert-quality-hint').length, 0, '说明不应再占独立行');
	const info = byClass(host.contentEl, 'orphan-cleanup-convert-quality-info')[0];
	assert.ok(info, '应有 info 图标承载说明');
	assert.match(info.title, /100 = 最高质量/);
	assert.match(info.getAttribute('aria-label'), /质量说明/);
	assert.doesNotMatch(info.title, /PNG 输出为无损/);
	host.conversion.target = 'png';
	host.contentEl.empty();
	renderConversionList(host);
	const pngInfo = byClass(host.contentEl, 'orphan-cleanup-convert-quality-info')[0];
	assert.equal(byClass(host.contentEl, 'orphan-cleanup-convert-quality-input')[0].disabled, true);
	assert.match(pngInfo.title, /PNG 输出为无损，质量设置不适用/);
});

test('单一顶部卡片承载操作栏、源格式、控制项与汇总', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png', oldBytes: 100, newBytes: 40 })]);
	renderConversionList(host);

	const cards = byClass(host.contentEl, 'orphan-cleanup-convert-card');
	assert.equal(cards.length, 1);
	const card = cards[0];
	assert.equal(byClass(card, 'orphan-cleanup-convert-toolbar').length, 1);
	assert.equal(byClass(card, 'orphan-cleanup-convert-fieldset').length, 2);
	assert.equal(byClass(card, 'orphan-cleanup-convert-summary').length, 1);
	assert.equal(byClass(card, 'orphan-cleanup-convert-hint').length, 1);
	assert.match(byClass(card, 'orphan-cleanup-convert-hint')[0].textContent, /原图移入回收站，可恢复/);
	// 长说明段落已移除，只保留源格式为空时的警告（默认已选 PNG，因此隐藏）。
	assert.equal(byClass(card, 'orphan-cleanup-convert-note').length, 1);
	assert.doesNotMatch(host.contentEl.textContent, /体积为按源格式与质量推算的预估值/);
});

test('全部选择包含非节省的未阻断项，取消选择清空且不污染共享 selections', () => {
	const host = makeHost([
		makeItem({ path: 'pics/save.png', oldBytes: 100, newBytes: 40 }),
		makeItem({ path: 'pics/grow.png', oldBytes: 100, newBytes: 140 }),
		makeItem({ path: 'pics/same.png', oldBytes: 100, newBytes: 100 }),
		makeItem({ path: 'pics/blocked.png', oldBytes: 500, newBytes: 10, blockedReason: '目标文件已存在' }),
	]);
	renderConversionList(host);

	byText(host.contentEl, 'button', '全部选择')[0].dispatch('click');
	assert.deepEqual([...host.convertSelections].sort(), ['pics/grow.png', 'pics/same.png', 'pics/save.png']);
	assert.equal(host.selections.size, 0);
	assert.match(byClass(host.contentEl, 'orphan-cleanup-convert-selection-summary')[0].textContent, /已选：3 张/);

	byText(host.contentEl, 'button', '取消选择')[0].dispatch('click');
	assert.equal(host.convertSelections.size, 0);
	assert.match(byClass(host.contentEl, 'orphan-cleanup-convert-selection-summary')[0].textContent, /已选：0 张/);
});

test('全部选择/取消选择在忙碌时禁用，取消选择在无选择时禁用', () => {
	const host = makeHost([makeItem({ path: 'pics/a.png' })]);
	renderConversionList(host);
	assert.equal(byText(host.contentEl, 'button', '全部选择')[0].disabled, false);
	assert.equal(byText(host.contentEl, 'button', '取消选择')[0].disabled, true, '无选择时应禁用取消选择');

	const checkbox = byClass(host.contentEl, 'orphan-cleanup-convert-row')[0].querySelector('input');
	checkbox.checked = true;
	checkbox.dispatch('change');
	assert.equal(byText(host.contentEl, 'button', '取消选择')[0].disabled, false, '勾选后取消选择应立即可用');

	host.conversion.estimating = true;
	host.contentEl.empty();
	renderConversionList(host);
	assert.equal(byText(host.contentEl, 'button', '全部选择')[0].disabled, true);
	assert.equal(byText(host.contentEl, 'button', '取消选择')[0].disabled, true);
});

test('引用 1 处直接打开笔记，0 处给出中文提示', () => {
	globalThis.__openedLinks = [];
	globalThis.__notices = [];
	const host = makeHost([
		makeItem({ path: 'pics/one.png', referenceCount: 1, sourceNotePaths: ['笔记/甲.md'] }),
		makeItem({ path: 'pics/zero.png', referenceCount: 0, sourceNotePaths: [] }),
	]);
	renderConversionList(host);

	const refs = byClass(host.contentEl, 'orphan-cleanup-convert-references');
	const oneButton = byTag(refs[0], 'button')[0];
	assert.match(oneButton.getAttribute('aria-label'), /打开引用此图片的笔记/);
	oneButton.dispatch('click');
	assert.deepEqual(globalThis.__openedLinks, ['笔记/甲.md']);

	const zeroButton = byTag(refs[1], 'button')[0];
	zeroButton.dispatch('click');
	assert.ok(globalThis.__notices.some((message) => /没有可跳转的引用笔记/.test(message)));
	assert.deepEqual(globalThis.__openedLinks, ['笔记/甲.md'], '0 处时不应打开任何笔记');
});

test('引用多处弹出内联菜单，选中后打开对应笔记', () => {
	globalThis.__openedLinks = [];
	const host = makeHost([
		makeItem({ path: 'pics/many.png', referenceCount: 3, sourceNotePaths: ['笔记/甲.md', '笔记/乙.md', '笔记/甲.md'] }),
	]);
	renderConversionList(host);

	const button = byTag(byClass(host.contentEl, 'orphan-cleanup-convert-references')[0], 'button')[0];
	button.dispatch('click');
	const menu = byClass(host.contentEl, 'orphan-cleanup-convert-ref-menu')[0];
	assert.ok(menu, '多处引用应弹出内联菜单');
	const items = byClass(menu, 'orphan-cleanup-convert-ref-menu-item');
	assert.equal(items.length, 2, '重复路径应去重');
	assert.deepEqual(items.map((item) => item.textContent), ['笔记/甲.md', '笔记/乙.md']);

	items[1].dispatch('click');
	assert.deepEqual(globalThis.__openedLinks, ['笔记/乙.md']);
	assert.equal(byClass(host.contentEl, 'orphan-cleanup-convert-ref-menu').length, 0, '打开后菜单应关闭');
});
