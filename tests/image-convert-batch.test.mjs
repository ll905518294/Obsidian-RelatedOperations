import test from 'node:test';
import assert from 'node:assert/strict';
import {
	findImageReferences,
	findImageReferencesBatch,
} from '../src/image-convert/image-convert-links.ts';

const file = (path) => ({ path, extension: path.split('.').at(-1).toLowerCase() });

function normalizePath(path) {
	const parts = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}

function resolveLinkFor(allFiles, link, sourcePath) {
	const clean = link.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
	const decoded = decodeURIComponent(clean);
	if (decoded.startsWith('/')) {
		const absolute = decoded.slice(1);
		return allFiles.find((item) => item.path === absolute) ?? null;
	}
	const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
	const relative = normalizePath([directory, decoded].filter(Boolean).join('/'));
	const relativeFile = allFiles.find((item) => item.path === relative);
	if (relativeFile) return relativeFile;
	const direct = allFiles.find((item) => item.path === decoded);
	if (direct) return direct;
	const name = decoded.slice(decoded.lastIndexOf('/') + 1);
	const matches = allFiles.filter((item) => item.path.slice(item.path.lastIndexOf('/') + 1) === name);
	return matches[0] ?? null;
}

function makeApp({ contents, resolvedLinks = {}, caches = {}, files, reads }) {
	const allFiles = files ?? Object.keys(contents).map(file);
	const app = {
		vault: {
			getFiles: () => allFiles,
			getFileByPath: (path) => allFiles.find((item) => item.path === path) ?? null,
			cachedRead: async (item) => contents[item.path] ?? '',
		},
		metadataCache: {
			resolvedLinks,
			getFileCache: (item) => caches[item.path] ?? {},
			getFirstLinkpathDest: (link, sourcePath) => resolveLinkFor(allFiles, link, sourcePath),
		},
	};
	if (reads) {
		app.vault.read = async (item) => {
			reads.push(item.path);
			return contents[item.path] ?? '';
		};
	}
	return app;
}

function span(content, original, from = 0) {
	const start = content.indexOf(original, from);
	assert.ok(start >= 0, `找不到片段 ${original}`);
	return { start: { offset: start }, end: { offset: start + original.length } };
}

async function parity(app, targets) {
	const batch = await findImageReferencesBatch(app, targets);
	assert.deepEqual([...batch.keys()].sort(), [...targets].sort());
	for (const target of targets) {
		assert.deepEqual(batch.get(target), await findImageReferences(app, target), `目标 ${target}`);
	}
	return batch;
}

const mainContents = {
	'assets/a.png': '',
	'assets/b.png': '',
	'assets/c.png': '',
	'assets/d.png': '',
	'assets/e.png': '',
	'assets/f.png': '',
	'assets/g.png': '',
	'assets/h.png': '',
	'assets/z.png': '',
	'note-wiki.md': '![[a.png]]\n\n![[b.png|300]]\n',
	'note-md.md': '![](assets/a.png)\n\n[x](assets/c.png)\n\n<img src="assets/d.png">\n',
	'note-css.md': '<style>.x{background:url("assets/e.png")}</style>\n',
	'note-excalidraw.excalidraw.md': '```md\n![[f.png]]\n```\n',
	'note-frontmatter.md': '---\ncover: assets/g.png\n---\n',
	'board.canvas': JSON.stringify({
		nodes: [
			{ id: 'i', type: 'file', file: 'assets/a.png' },
			{ id: 't', type: 'text', text: '![[h.png]]' },
		],
		edges: [],
	}, null, '\t'),
	'note-text.md': '```\nsee assets/c.png here\n```\n',
	'missing.md': 'nothing here',
};

function mainApp() {
	const wiki = mainContents['note-wiki.md'];
	const md = mainContents['note-md.md'];
	return makeApp({
		contents: mainContents,
		resolvedLinks: {
			'note-wiki.md': { 'assets/a.png': 1, 'assets/b.png': 1 },
			'note-md.md': { 'assets/a.png': 1, 'assets/c.png': 1, 'assets/d.png': 1 },
		},
		caches: {
			'note-wiki.md': {
				embeds: [
					{ link: 'a.png', original: '![[a.png]]', position: span(wiki, '![[a.png]]') },
					{ link: 'b.png', original: '![[b.png|300]]', position: span(wiki, '![[b.png|300]]') },
				],
			},
			'note-md.md': {
				embeds: [{ link: 'assets/a.png', original: '![](assets/a.png)', position: span(md, '![](assets/a.png)') }],
				links: [{ link: 'assets/c.png', original: '[x](assets/c.png)', position: span(md, '[x](assets/c.png)') }],
			},
		},
	});
}

test('批量扫描与逐图扫描的结果逐项一致', async () => {
	const targets = [
		'assets/a.png', 'assets/b.png', 'assets/c.png', 'assets/d.png', 'assets/e.png',
		'assets/f.png', 'assets/g.png', 'assets/h.png', 'assets/z.png', 'missing.png',
	];
	const batch = await parity(mainApp(), targets);

	const a = batch.get('assets/a.png');
	assert.equal(a.ok, true);
	assert.equal(a.totalLiveRefs, 3);
	assert.deepEqual(a.sites.map((site) => site.sourcePath).sort(), ['board.canvas', 'note-md.md', 'note-wiki.md']);

	assert.equal(batch.get('assets/b.png').reason, 'has-size');
	assert.equal(batch.get('assets/c.png').totalLiveRefs, 1);
	assert.equal(batch.get('assets/c.png').totalTextMentions, 0);
	assert.equal(batch.get('assets/d.png').totalLiveRefs, 1);
	assert.equal(batch.get('assets/e.png').reason, 'css-url');
	assert.equal(batch.get('assets/f.png').reason, 'code-block-reference');
	assert.equal(batch.get('assets/g.png').reason, 'frontmatter-plain-path');
	assert.equal(batch.get('assets/h.png').reason, 'canvas-text-embed');
	assert.equal(batch.get('assets/z.png').ok, true);
	assert.equal(batch.get('assets/z.png').totalLiveRefs, 0);
	assert.equal(batch.get('missing.png').reason, 'unsupported-source');
});

test('损坏的 Canvas 会让仍未完成的图片得到同一条错误结果', async () => {
	const targets = ['assets/a.png', 'assets/z.png'];
	const app = makeApp({
		contents: {
			'assets/a.png': '',
			'assets/z.png': '',
			'note.md': '![[a.png]]\n',
			'broken.canvas': '{not json',
		},
		resolvedLinks: { 'note.md': { 'assets/a.png': 1 } },
		caches: { 'note.md': { embeds: [{ link: 'a.png', original: '![[a.png]]', position: span('![[a.png]]', '![[a.png]]') }] } },
	});
	const batch = await parity(app, targets);
	for (const target of targets) {
		assert.equal(batch.get(target).ok, false);
		assert.equal(batch.get(target).reason, 'unsupported-source');
		assert.equal(batch.get(target).sourcePath, 'broken.canvas');
	}
});

function fuzzVault(round) {
	let seed = 987_654_321 + round * 7919;
	const random = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	const pick = (list) => list[Math.floor(random() * list.length)];
	const targets = ['assets/a.png', 'assets/b.png', 'assets/c.png', 'notes/c.png'];
	const contents = Object.fromEntries(targets.map((path) => [path, '']));
	const resolvedLinks = {};
	const caches = {};
	for (let noteIndex = 0; noteIndex < 4; noteIndex++) {
		const notePath = `notes/note-${noteIndex}.md`;
		const lines = [];
		const entries = [];
		const counts = new Map();
		if (random() < 0.3) lines.push('---', `cover: ${pick(targets)}`, '---', '');
		for (let refIndex = 0; refIndex < 3; refIndex++) {
			if (random() < 0.25) break;
			const target = pick(targets);
			const syntax = pick(['wiki', 'wiki-size', 'md', 'md-link', 'html']);
			if (syntax === 'wiki') lines.push(`![[${target}]]`);
			else if (syntax === 'wiki-size') lines.push(`![[${target}|${pick([100, 200])}]]`);
			else if (syntax === 'md') lines.push(`![](${target})`);
			else if (syntax === 'md-link') lines.push(`[text](${target})`);
			else lines.push(`<img src="${target}">`);
			entries.push({ target, syntax });
			counts.set(target, (counts.get(target) ?? 0) + 1);
		}
		if (random() < 0.5) lines.push('```', `see ${pick(targets)} in code`, '```');
		const content = `${lines.join('\n')}\n`;
		contents[notePath] = content;
		const cache = { embeds: [], links: [] };
		let cursor = 0;
		for (const entry of entries) {
			const original = entry.syntax === 'wiki' ? `![[${entry.target}]]`
				: entry.syntax === 'wiki-size' ? `![[${entry.target}|`
				: entry.syntax === 'md' ? `![](${entry.target})`
				: entry.syntax === 'md-link' ? `[text](${entry.target})`
				: `<img src="${entry.target}">`;
			if (entry.syntax === 'wiki-size') {
				const start = content.indexOf(original, cursor);
				const end = content.indexOf(']]', start) + 2;
				cache.embeds.push({ link: entry.target, original: content.slice(start, end), position: { start: { offset: start }, end: { offset: end } } });
				cursor = end;
				continue;
			}
			const position = span(content, original, cursor);
			cursor = position.end.offset;
			if (entry.syntax === 'wiki' || entry.syntax === 'md') cache.embeds.push({ link: entry.target, original, position });
			else if (entry.syntax === 'md-link') cache.links.push({ link: entry.target, original, position });
		}
		caches[notePath] = cache;
		if (counts.size > 0) resolvedLinks[notePath] = Object.fromEntries(counts);
	}
	return { app: makeApp({ contents, resolvedLinks, caches, files: Object.keys(contents).map(file) }), targets };
}

test('随机库上批量结果与逐图结果保持一致', async () => {
	for (let round = 0; round < 40; round++) {
		const { app, targets } = fuzzVault(round);
		const batch = await findImageReferencesBatch(app, targets);
		for (const target of targets) {
			assert.deepEqual(batch.get(target), await findImageReferences(app, target), `round ${round} target ${target}`);
		}
	}
});

test('批量扫描每篇笔记只读取一次，不随图片数量放大', async () => {
	const reads = [];
	const contents = { 'assets/a.png': '', 'assets/b.png': '', 'assets/c.png': '' };
	for (let index = 0; index < 40; index++) {
		contents[`notes/${index}.md`] = index % 2 === 0 ? '![[a.png]]\n' : 'see nothing here\n';
	}
	const app = makeApp({
		contents,
		files: Object.keys(contents).map(file),
		resolvedLinks: Object.fromEntries(
			Array.from({ length: 40 }, (_, index) => [`notes/${index}.md`, index % 2 === 0 ? { 'assets/a.png': 1 } : {}]),
		),
		caches: Object.fromEntries(
			Array.from({ length: 40 }, (_, index) => [`notes/${index}.md`, {
				embeds: index % 2 === 0 ? [{ link: 'a.png', original: '![[a.png]]', position: { start: { offset: 0 }, end: { offset: 10 } } }] : [],
			}]),
		),
		reads,
	});
	await findImageReferencesBatch(app, ['assets/a.png', 'assets/b.png', 'assets/c.png']);
	assert.equal(reads.length, 40, `批量扫描读取了 ${reads.length} 次`);
	assert.ok(reads.every((path) => path.endsWith('.md')));
});
