import test from 'node:test';
import assert from 'node:assert/strict';
import {
	checkCleanupInvariants,
	duplicateSelectionsOutsideGroups,
	lastPageIndex,
	pageIndexInBounds,
	pathSelectionsOutsideCandidates,
	reportCleanupInvariants,
} from '../src/cleanup/cleanup-invariants.ts';

function candidates(overrides = {}) {
	return {
		images: [],
		attachments: [],
		emptyFiles: [],
		folders: [],
		brokenLinks: [],
		nativeLinks: [],
		brokenNoteLinks: [],
		duplicates: [],
		duplicateWarnings: [],
		convertibleImages: [],
		...overrides,
	};
}

function state(overrides = {}) {
	return {
		activeTab: 'overview',
		scanning: false,
		scanStages: [],
		scanProgress: { stage: 0, processed: 0, total: 0 },
		scanElapsedMs: 0,
		scannedTabs: new Set(),
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		pages: new Map(),
		selections: new Set(),
		linkSelections: new Set(),
		nativeSelections: new Set(),
		noteLinkSelections: new Set(),
		duplicateSelections: new Set(),
		candidates: candidates(),
		...overrides,
	};
}

test('干净状态没有不变量问题', () => {
	assert.deepEqual(checkCleanupInvariants(state()), []);
	const tabs = new Set(['images', 'folders']);
	assert.deepEqual(checkCleanupInvariants(state({ scannedTabs: tabs, dirtyTabs: new Set(['folders']) })), []);
});

test('图片转换标签出现在扫描状态与分页里不算不变量错误', () => {
	const conversionTabs = new Set(['image-convert']);
	assert.deepEqual(checkCleanupInvariants(state({
		scannedTabs: new Set(['images', 'image-convert']),
		scanningTabs: conversionTabs,
		dirtyTabs: conversionTabs,
		activeTab: 'image-convert',
		pages: new Map([['image-convert', 1]]),
		candidates: candidates({ convertibleImages: [{ path: 'a.png' }] }),
	})), []);
	// 非法分页值仍然要被发现。
	const issues = checkCleanupInvariants(state({ pages: new Map([['image-convert', -1]]) }));
	assert.ok(issues.some((issue) => issue.includes('pages[image-convert] 不是非负整数')));
});

test('分类标签集合不能包含 overview 或未知标签', () => {
	const issues = checkCleanupInvariants(state({ scannedTabs: new Set(['overview']), scanningTabs: new Set(['bogus']), dirtyTabs: new Set(['overview']) }));
	assert.equal(issues.filter((issue) => issue.startsWith('scannedTabs')).length, 1);
	assert.equal(issues.filter((issue) => issue.startsWith('scanningTabs')).length, 1);
	assert.equal(issues.filter((issue) => issue.startsWith('dirtyTabs')).length, 1);
});

test('全量扫描时停留在首页且不并发分类扫描', () => {
	assert.deepEqual(checkCleanupInvariants(state({ scanning: true, activeTab: 'overview' })), []);
	const issues = checkCleanupInvariants(state({ scanning: true, activeTab: 'images', scanningTabs: new Set(['folders']) }));
	assert.ok(issues.some((issue) => issue.includes('activeTab 应为 overview')));
	assert.ok(issues.some((issue) => issue.includes('scanningTabs 应为空')));
	assert.deepEqual(checkCleanupInvariants(state({ activeTab: 'images', scanningTabs: new Set(['images']) })), []);
});

test('扫描进度必须落在阶段范围内且计数非负', () => {
	const stages = [{ label: 'a', state: 'scanning', elapsedMs: 0 }];
	assert.deepEqual(checkCleanupInvariants(state({ scanStages: stages, scanProgress: { stage: 0, processed: 1, total: 2 } })), []);
	const issues = checkCleanupInvariants(state({ scanStages: stages, scanProgress: { stage: 1, processed: -1, total: -2 }, scanElapsedMs: -5 }));
	assert.ok(issues.some((issue) => issue.includes('超出 1 个扫描阶段')));
	assert.ok(issues.some((issue) => issue.includes('计数为负')));
	assert.ok(issues.some((issue) => issue.includes('scanElapsedMs 为负')));
});

test('分页键与当前页必须和列表长度一致', () => {
	assert.equal(lastPageIndex(0, 100), 0);
	assert.equal(lastPageIndex(1, 100), 0);
	assert.equal(lastPageIndex(100, 100), 0);
	assert.equal(lastPageIndex(101, 100), 1);
	assert.equal(lastPageIndex(1000, 100), 9);

	assert.equal(pageIndexInBounds(0, 0, 100), true);
	assert.equal(pageIndexInBounds(-1, 0, 100), false);
	assert.equal(pageIndexInBounds(1, 0, 100), false);
	assert.equal(pageIndexInBounds(9, 1000, 100), true);
	assert.equal(pageIndexInBounds(10, 1000, 100), false);

	const images = Array.from({ length: 1000 }, (_, index) => ({ path: `img-${index}.png` }));
	assert.deepEqual(checkCleanupInvariants(state({ activeTab: 'images', candidates: candidates({ images }), pages: new Map([['images', 9]]) })), []);
	const issues = checkCleanupInvariants(state({ activeTab: 'images', candidates: candidates({ images }), pages: new Map([['images', 10], ['overview', 0], ['broken-links', -1]]) }));
	assert.ok(issues.some((issue) => issue.includes('pages[images]=10')));
	assert.ok(issues.some((issue) => issue.includes('pages 含非分类标签：overview')));
	assert.ok(issues.some((issue) => issue.includes('pages[broken-links] 不是非负整数')));
});

test('选择键必须符合路径/链接键格式', () => {
	assert.deepEqual(checkCleanupInvariants(state({
		selections: new Set(['note.md', 'folder/img.png']),
		duplicateSelections: new Set(['dup.png']),
		linkSelections: new Set(['a.md\u00000:8']),
		nativeSelections: new Set(['b.md\u00003:9']),
		noteLinkSelections: new Set(['c.md\u00001:2']),
	})), []);

	const issues = checkCleanupInvariants(state({
		selections: new Set(['bad\u0000key', '']),
		linkSelections: new Set(['no-separator']),
		noteLinkSelections: new Set(['a.md\u0000']),
	}));
	assert.ok(issues.some((issue) => issue.includes('含链接键格式的路径')));
	assert.ok(issues.some((issue) => issue.includes('含空路径')));
	assert.ok(issues.some((issue) => issue.includes('格式错误的链接键')));
});

test('选择漂移诊断只报告不在候选中的路径', () => {
	const value = state({
		candidates: candidates({
			images: [{ path: 'kept.png' }],
			folders: [{ path: 'kept-folder' }],
			convertibleImages: [{ path: 'convert.png' }],
			duplicates: [{ files: [{ path: 'dup-a.png' }, { path: 'dup-b.png' }] }],
		}),
		selections: new Set(['kept.png', 'kept-folder', 'convert.png', 'gone.png']),
		duplicateSelections: new Set(['dup-a.png', 'gone-dup.png']),
	});
	assert.deepEqual(pathSelectionsOutsideCandidates(value), ['gone.png']);
	assert.deepEqual(duplicateSelectionsOutsideGroups(value), ['gone-dup.png']);
});

test('reportCleanupInvariants 只在开发环境告警并按内容去重', () => {
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = 'development';
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (message) => warnings.push(String(message));
	try {
		reportCleanupInvariants(state());
		reportCleanupInvariants(state({ scannedTabs: new Set(['overview']) }));
		reportCleanupInvariants(state({ scannedTabs: new Set(['overview']) }));
		reportCleanupInvariants(state());
		reportCleanupInvariants(state({ scannedTabs: new Set(['overview']) }));
	} finally {
		console.warn = originalWarn;
		process.env.NODE_ENV = previous;
	}
	assert.equal(warnings.length, 2);
	assert.ok(warnings.every((message) => message.startsWith('[cleanup-invariants]')));
});

test('生产环境不执行不变量告警', () => {
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = 'production';
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (message) => warnings.push(String(message));
	try {
		reportCleanupInvariants(state({ scannedTabs: new Set(['overview']) }));
	} finally {
		console.warn = originalWarn;
		process.env.NODE_ENV = previous;
	}
	assert.equal(warnings.length, 0);
});

// Capacitor/mobile builds have no Node `process` global. The cleanup panel is
// reachable there through the mobile Modal fallback, so the invariant reporter
// must skip instead of throwing ReferenceError/TypeError.
test('缺少 process 全局时安全跳过，不抛错', () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
	assert.ok(descriptor, 'Node 测试环境应存在 process 全局');
	try {
		Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true });
		assert.equal(typeof process, 'undefined');
		assert.doesNotThrow(() => reportCleanupInvariants(state({ scannedTabs: new Set(['overview']) })));
	} finally {
		Object.defineProperty(globalThis, 'process', descriptor);
	}
	assert.equal(typeof process, 'object');
});
