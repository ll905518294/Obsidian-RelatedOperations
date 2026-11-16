import test from 'node:test';
import assert from 'node:assert/strict';
import {
	analyzeReferenceContent,
	countRemainingReferences,
	findImageReferences,
	rewriteImageReferences,
} from '../src/image-convert/image-convert-links.ts';

const rewrite = (content, oldPath, newPath, sourcePath = 'note.md', resolveLink) =>
	rewriteImageReferences(content, oldPath, newPath, 'markdown', { sourcePath, resolveLink, vaultPaths: [] });

const rewriteCanvas = (content, oldPath, newPath, sourcePath = 'board.canvas', resolveLink) =>
	rewriteImageReferences(content, oldPath, newPath, 'canvas', { sourcePath, resolveLink, vaultPaths: [] });

const file = (path) => ({ path, extension: path.split('.').at(-1).toLowerCase() });

function makeApp({ contents, resolvedLinks = {}, caches = {}, files }) {
	const allFiles = files ?? Object.keys(contents).map(file);
	return {
		vault: {
			getFiles: () => allFiles,
			getFileByPath: (path) => allFiles.find((item) => item.path === path) ?? null,
			cachedRead: async (item) => contents[item.path] ?? '',
		},
		metadataCache: {
			resolvedLinks,
			getFileCache: (item) => caches[item.path] ?? {},
			getFirstLinkpathDest: (link, sourcePath) => resolveLinkFor(contents, allFiles, link, sourcePath),
		},
	};
}

function resolveLinkFor(contents, allFiles, link, sourcePath) {
	const clean = link.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
	const decoded = decodeURIComponent(clean);
	if (decoded.startsWith('/')) {
		const absolute = decoded.slice(1);
		return allFiles.find((item) => item.path === absolute) ?? null;
	}
	const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
	const relative = normalize([directory, decoded].filter(Boolean).join('/'));
	const relativeFile = allFiles.find((item) => item.path === relative);
	if (relativeFile) return relativeFile;
	const direct = allFiles.find((item) => item.path === decoded);
	if (direct) return direct;
	const name = decoded.slice(decoded.lastIndexOf('/') + 1);
	const matches = allFiles.filter((item) => item.path.slice(item.path.lastIndexOf('/') + 1) === name);
	return matches.length === 1 ? matches[0] : matches[0] ?? null;
}

function normalize(path) {
	const parts = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}

test('converts wiki embeds and keeps aliases as alt text', () => {
	assert.equal(rewrite('![[a.png]]', 'Attachments/a.png', 'Attachments/a.webp').content, '![](<Attachments/a.webp>)');
	assert.equal(
		rewrite('![[a.png|示意图]]', 'Attachments/a.png', 'Attachments/a.webp').content,
		'![示意图](<Attachments/a.webp>)',
	);
	assert.equal(
		rewrite('前 ![[a.png|示意图]] 后', 'Attachments/a.png', 'Attachments/a.webp').content,
		'前 ![示意图](<Attachments/a.webp>) 后',
	);
});

test('rejects every wiki embed that carries a size parameter', () => {
	for (const content of ['![[a.png|300]]', '![[a.png|300x200]]', '![[a.png|别名|300]]']) {
		const result = rewrite(content, 'Attachments/a.png', 'Attachments/a.webp');
		assert.equal(result.rewritten, 0);
		assert.equal(result.content, content);
		assert.equal(result.blockedReason, 'has-size');
		assert.match(result.reasonText, /尺寸/);
	}
});

test('enumerates a no-extension wiki embed and adds the new extension', () => {
	const result = rewrite('![[cover]]', 'Attachments/cover.png', 'Attachments/cover.webp');
	assert.equal(result.content, '![](<Attachments/cover.webp>)');
	assert.equal(result.rewritten, 1);
});

test('rejects an ambiguous no-extension basename', () => {
	const result = rewriteImageReferences(
		'![[cover]]',
		'Attachments/cover.png',
		'Attachments/cover.webp',
		'markdown',
		{ sourcePath: 'note.md', vaultPaths: ['x/cover.png', 'y/cover.png'] },
	);
	assert.equal(result.blockedReason, 'ambiguous-basename');
	assert.equal(result.content, '![[cover]]');
});

test('rewrites only the same-named cover that the resolver points at', () => {
	const resolveLink = (link) => link === 'cover.png' ? 'x/cover.png' : null;
	assert.equal(
		rewrite('![[cover.png]]', 'x/cover.png', 'x/cover.webp', 'note.md', resolveLink).content,
		'![](<x/cover.webp>)',
	);
	assert.equal(
		rewrite('![[cover.png]]', 'y/cover.png', 'y/cover.webp', 'note.md', resolveLink).content,
		'![[cover.png]]',
	);
});

test('converts non-embed wiki links without adding a bang', () => {
	assert.equal(rewrite('[[a.png]]', 'a.png', 'a.webp').content, '[a.png](<a.webp>)');
	assert.equal(rewrite('[[a.png|说明]]', 'a.png', 'a.webp').content, '[说明](<a.webp>)');
	assert.equal(rewrite('[文字](a.png)', 'a.png', 'a.webp').content, '[文字](a.webp)');
});

test('preserves markdown alt text, angle brackets, encoding and titles', () => {
	assert.equal(rewrite('![alt](a.png)', 'a.png', 'a.webp').content, '![alt](a.webp)');
	assert.equal(rewrite('![alt](<a b.png>)', 'a b.png', 'a b.webp').content, '![alt](<a b.webp>)');
	assert.equal(rewrite('![alt](a%20b.png)', 'a b.png', 'a b.webp').content, '![alt](a%20b.webp)');
	assert.doesNotMatch(rewrite('![alt](a%20b.png)', 'a b.png', 'a b.webp').content, /%2520/);
	assert.equal(rewrite('![alt](a.png "标题")', 'a.png', 'a.webp').content, '![alt](a.webp "标题")');
});

test('preserves relative and vault-absolute markdown link styles', () => {
	assert.equal(
		rewrite('![alt](../Attachments/a.png)', 'Attachments/a.png', 'Attachments/a.webp', 'notes/note.md').content,
		'![alt](../Attachments/a.webp)',
	);
	assert.equal(
		rewrite('![alt](/Attachments/a.png)', 'Attachments/a.png', 'Attachments/a.webp', 'notes/note.md').content,
		'![alt](../Attachments/a.webp)',
	);
});

test('[B2] markdown and wiki rewrites stay relative to the source note', () => {
	const resolveLink = (link) => link === 'cover.png' || link === '/Attachments/cover.png'
		? 'Attachments/cover.png'
		: null;
	assert.equal(
		rewrite('![[cover.png]]', 'Attachments/cover.png', 'Attachments/cover.webp', 'notes/note.md').content,
		'![](<../Attachments/cover.webp>)',
	);
	assert.equal(
		rewrite('![x](cover.png)', 'Attachments/cover.png', 'Attachments/cover.webp', 'notes/note.md', resolveLink).content,
		'![x](../Attachments/cover.webp)',
	);
	assert.equal(
		rewrite('![x](/Attachments/cover.png)', 'Attachments/cover.png', 'Attachments/cover.webp', 'notes/note.md', resolveLink).content,
		'![x](../Attachments/cover.webp)',
	);
	assert.equal(
		rewrite('![[cover.png|示意图]]', 'Attachments/cover.png', 'Attachments/cover.webp', 'notes/note.md').content,
		'![示意图](<../Attachments/cover.webp>)',
	);
	assert.equal(
		rewrite('![[cover.png]]', 'Attachments/cover.png', 'Attachments/cover.webp', 'note.md').content,
		'![](<Attachments/cover.webp>)',
	);
	const canvas = JSON.stringify({
		nodes: [{ id: 'image', type: 'file', file: 'Attachments/cover.png' }],
		edges: [],
	}, null, '\t');
	assert.equal(
		JSON.parse(rewriteCanvas(canvas, 'Attachments/cover.png', 'Attachments/cover.webp', 'notes/board.canvas').content)
			.nodes[0].file,
		'Attachments/cover.webp',
	);
});

test('skips external links, data URIs and protocol-relative URLs', () => {
	for (const content of [
		'![x](https://host/a.png)',
		'![x](data:image/png;base64,a.png)',
		'![x](//host/a.png)',
	]) {
		const result = rewrite(content, 'a.png', 'a.webp');
		assert.equal(result.content, content);
		assert.equal(result.rewritten, 0);
	}
});

test('rewrites HTML img src while leaving every other attribute intact', () => {
	assert.equal(
		rewrite('<img src="a.png" width="10" alt="x">', 'a.png', 'a.webp').content,
		'<img src="a.webp" width="10" alt="x">',
	);
	assert.equal(
		rewrite("<img width=10 src='a.png' data-x='a.png'>", 'a.png', 'a.webp').content,
		"<img width=10 src='a.webp' data-x='a.png'>",
	);
});

test('does not rewrite link-like text inside HTML attributes', () => {
	const content = '<img alt="[[a.png]] [x](a.png)" src="a.png" width="10">';
	const result = rewrite(content, 'a.png', 'a.webp');
	assert.equal(result.content, '<img alt="[[a.png]] [x](a.png)" src="a.webp" width="10">');
	assert.equal(result.rewritten, 1);
});

test('rejects srcset instead of partially rewriting an img tag', () => {
	for (const content of [
		'<img src="a.png" srcset="a.png 1x, b.png 2x">',
		'<img src="b.png" srcset="a.png 1x">',
	]) {
		const result = rewrite(content, 'a.png', 'a.webp');
		assert.equal(result.content, content);
		assert.equal(result.blockedReason, 'srcset');
	}
});

test('rejects plain frontmatter paths and rewrites frontmatter wiki links', () => {
	const plain = rewrite('---\ncover: a.png\n---\n', 'a.png', 'a.webp');
	assert.equal(plain.blockedReason, 'frontmatter-plain-path');
	assert.equal(plain.content, '---\ncover: a.png\n---\n');

	const wiki = rewrite('---\ncover: "[[a.png]]"\n---\n', 'a.png', 'a.webp');
	assert.equal(wiki.content, '---\ncover: "[[a.webp]]"\n---\n');
	assert.match(wiki.content, /cover: "\[\[a\.webp\]\]"/);
});

test('keeps code blocks and inline code byte-for-byte while counting text mentions', () => {
	const content = [
		'![[a.png]]',
		'```md',
		'![[a.png]]',
		'```',
		'`a.png`',
		'',
	].join('\n');
	const analysis = analyzeReferenceContent(content, 'a.png', 'note.md', 'markdown');
	assert.equal(analysis.liveRefs, 1);
	assert.equal(analysis.textMentions, 2);
	const result = rewrite(content, 'a.png', 'a.webp');
	assert.equal(result.rewritten, 1);
	assert.match(result.content, /!\[\]\(<a\.webp>\)/);
	assert.match(result.content, /```md\n!\[\[a\.png\]\]\n```/);
	assert.match(result.content, /`a\.png`/);
});

test('rewrites Canvas file nodes and leaves nodes and edges intact', () => {
	const content = JSON.stringify({
		nodes: [
			{ id: 'image', type: 'file', file: 'a.png', x: 1, y: 2 },
			{ id: 'text', type: 'text', text: 'hello', x: 3 },
		],
		edges: [{ id: 'edge', fromNode: 'image', toNode: 'text' }],
	}, null, '\t');
	const result = rewriteCanvas(content, 'a.png', 'a.webp');
	const parsed = JSON.parse(result.content);
	assert.equal(parsed.nodes[0].file, 'a.webp');
	assert.deepEqual(parsed.nodes[1], { id: 'text', type: 'text', text: 'hello', x: 3 });
	assert.deepEqual(parsed.edges, [{ id: 'edge', fromNode: 'image', toNode: 'text' }]);
});

test('rejects Canvas text nodes that embed the image', () => {
	const content = JSON.stringify({
		nodes: [
			{ id: 'image', type: 'file', file: 'a.png' },
			{ id: 'text', type: 'text', text: '![[a.png]]' },
		],
		edges: [],
	}, null, '\t');
	const result = rewriteCanvas(content, 'a.png', 'a.webp');
	assert.equal(result.content, content);
	assert.equal(result.blockedReason, 'canvas-text-embed');
});

test('preserves subpaths, spaces, percent escapes and emoji in wiki targets', () => {
	assert.equal(rewrite('![[a.png#page]]', 'a.png', 'a.webp').content, '![](<a.webp#page>)');
	assert.equal(rewrite('![[a.png?download=1]]', 'a.png', 'a.webp').content, '![](<a.webp?download=1>)');
	assert.equal(
		rewrite('![x](a.png?download=1#page)', 'a.png', 'a.webp').content,
		'![x](a.webp?download=1#page)',
	);
	assert.equal(rewrite('![[图 😀.png]]', '图 😀.png', '图 😀.webp').content, '![](<图 😀.webp>)');
	assert.equal(
		rewrite('![x](%E5%9B%BE%20%F0%9F%98%80.png)', '图 😀.png', '图 😀.webp').content,
		'![x](%E5%9B%BE%20%F0%9F%98%80.webp)',
	);
});

test('honors case-sensitive link matching when the vault is case-sensitive', () => {
	const sensitive = rewriteImageReferences('![[A.PNG]]', 'a.png', 'a.webp', 'markdown', {
		sourcePath: 'note.md',
		caseSensitive: true,
	});
	assert.equal(sensitive.rewritten, 0);
	assert.equal(sensitive.content, '![[A.PNG]]');
	const insensitive = rewriteImageReferences('![[A.PNG]]', 'a.png', 'a.webp', 'markdown', {
		sourcePath: 'note.md',
		caseSensitive: false,
	});
	assert.equal(insensitive.rewritten, 1);
});

test('reports count mismatches per source instead of rewriting the note', async () => {
	const app = makeApp({
		contents: { 'note.md': '![[a.png]]', 'a.png': '' },
		resolvedLinks: { 'note.md': { 'a.png': 2 } },
		caches: {
			'note.md': {
				embeds: [{ link: 'a.png', original: '![[a.png]]', position: { start: { offset: 0 }, end: { offset: 10 } } }],
			},
		},
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'count-mismatch');
	assert.match(result.reasonText, /索引 2/);
});

test('detects an unindexed live reference even when the source has other resolved targets', async () => {
	const content = '![[a.png]]\n![[b.png]]';
	const app = makeApp({
		contents: { 'note.md': content, 'a.png': '', 'b.png': '' },
		resolvedLinks: { 'note.md': { 'b.png': 1 } },
		caches: {
			'note.md': {
				embeds: [
					{ link: 'a.png', original: '![[a.png]]', position: span(content, '![[a.png]]') },
					{ link: 'b.png', original: '![[b.png]]', position: span(content, '![[b.png]]') },
				],
			},
		},
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'count-mismatch');
	assert.equal(result.sourcePath, 'note.md');
	assert.match(result.reasonText, /索引 0/);
});

test('accepts Canvas references when Obsidian omits them from resolvedLinks', async () => {
	const content = JSON.stringify({
		nodes: [{ id: 'image', type: 'file', file: 'a.png' }],
		edges: [],
	}, null, '\t');
	const app = makeApp({
		contents: { 'board.canvas': content, 'a.png': '' },
		files: [file('board.canvas'), file('a.png')],
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, true);
	assert.deepEqual(result.sites, [{
		sourcePath: 'board.canvas',
		sourceKind: 'canvas',
		liveRefs: 1,
		textMentions: 0,
	}]);
});

test('rejects a Canvas source when its indexed count is present but different', async () => {
	const content = JSON.stringify({
		nodes: [{ id: 'image', type: 'file', file: 'a.png' }],
		edges: [],
	}, null, '\t');
	const app = makeApp({
		contents: { 'board.canvas': content, 'a.png': '' },
		files: [file('board.canvas'), file('a.png')],
		resolvedLinks: { 'board.canvas': { 'a.png': 2 } },
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'count-mismatch');
	assert.match(result.reasonText, /索引 2.*定位 1/);
});

test('[B7] rejects picture/source markup before rewriting', async () => {
	const note = '<picture><source src="a.png"><img src="a.png"></picture>';
	const app = makeApp({
		contents: { 'note.md': note, 'a.png': '' },
		resolvedLinks: { 'note.md': { 'a.png': 1 } },
		caches: { 'note.md': {} },
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'html-source');
});

test('[B7] rejects CSS url() references before rewriting', async () => {
	const note = '<style>.cover { background-image: url("a.png"); }</style>';
	const app = makeApp({
		contents: { 'note.md': note, 'a.png': '' },
		resolvedLinks: {},
		caches: { 'note.md': {} },
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'css-url');
});

test('[B7] rejects Excalidraw code-block references', async () => {
	const note = '```md\n![[a.png]]\n```\n';
	const app = makeApp({
		contents: { 'draw.excalidraw.md': note, 'a.png': '' },
		resolvedLinks: {},
		caches: { 'draw.excalidraw.md': {} },
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'code-block-reference');
});

test('deduplicates cached links that share the same span', async () => {
	const position = { start: { offset: 0 }, end: { offset: 10 } };
	const app = makeApp({
		contents: { 'note.md': '![[a.png]]', 'a.png': '' },
		resolvedLinks: { 'note.md': { 'a.png': 1 } },
		caches: {
			'note.md': {
				embeds: [{ link: 'a.png', original: '![[a.png]]', position }],
				links: [{ link: 'a.png', original: '![[a.png]]', position }],
			},
		},
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, true);
	assert.equal(result.totalLiveRefs, 1);
});

test('deduplicates a frontmatter link that also appears in cache.links', async () => {
	const content = '---\ncover: "[[a.png]]"\n---\n';
	const app = makeApp({
		contents: { 'note.md': content, 'a.png': '' },
		resolvedLinks: { 'note.md': { 'a.png': 1 } },
		files: [file('note.md'), file('a.png')],
		caches: {
			'note.md': {
				links: [{ link: 'a.png', original: '[[a.png]]', position: span(content, '[[a.png]]') }],
				frontmatterLinks: [{ key: 'cover', link: 'a.png', original: 'a.png' }],
			},
		},
	});
	const result = await findImageReferences(app, 'a.png');
	assert.equal(result.ok, true);
	assert.equal(result.totalLiveRefs, 1);
});

test('countRemainingReferences sees only live references, not code mentions', () => {
	const content = '![[a.png]]\n```\n![[a.png]]\n```\n`a.png`';
	assert.equal(countRemainingReferences(content, 'a.png', { sourcePath: 'note.md' }), 1);
});

function span(content, original) {
	const start = content.indexOf(original);
	return { start: { offset: start }, end: { offset: start + original.length } };
}
