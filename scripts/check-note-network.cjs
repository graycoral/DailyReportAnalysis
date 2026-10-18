// The graph must follow real rendered links, not examples or coincidental words.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { build } = require('esbuild');
(async () => {
  const compiled = await build({ entryPoints: ['frontend/note-network.js'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require, console, URL });
  const network = listing => JSON.parse(JSON.stringify(module.exports.buildNoteNetwork(listing)));
  const note = (id, file, body = '', reports = []) => ({ id, path: file, title: file.split('/').pop().slice(0, -3), body, reports, tags: [] });
  const notes = [
    note('a', '회의/회의록.md', '---\nexample: "[[무관]]"\n---\n[[../분석/기업 A#요약|회사]] [[../분석/기업 A]]\n[원문](../분석/기업%20A.md)\n[다른 노트][ref]\n\n[ref]: ../분석/기업%20B.md\n\n> [[독립]]\n\n`[[무관]]`\n```md\n[[무관]]\n```\n\n    [[무관]]\n\n\\[\\[무관]]\n![사진](../무관.md)\n[외부](https://example.com/무관.md)\n[서버](//example.com/무관.md)\n[[중복]] [[없는 노트]] [[회의록]]', ['r1', 'missing', 'r1']),
    note('b', '분석/기업 A.md', '[[회의/회의록]]'),
    note('c', '분석/기업 B.md'),
    note('d', '독립.md'),
    note('e', '무관.md'),
    note('f', '폴더1/중복.md'),
    note('g', '폴더2/중복.md'),
  ];
  const original = JSON.stringify(notes);
  let model = network({ notes, warnings: ['읽지 못한 파일'] });
  assert.equal(model.nodes.length, 7, 'unlinked notes remain visible');
  assert.deepEqual(model.links.map(l => [l.from, l.to]), [['note:a', 'note:b'], ['note:a', 'note:c'], ['note:a', 'note:d'], ['note:a', 'r:r1'], ['note:a', 'r:missing'], ['note:b', 'note:a']]);
  assert.ok(model.links.every(l => l.evidence && l.label));
  assert.match(model.links[0].evidence, /회의\/회의록.md.*\[\[/);
  assert.deepEqual(model.warnings, ['읽지 못한 파일']);
  assert.equal(JSON.stringify(notes), original, 'network never mutates note files or metadata');
  model = network({ notes: notes.filter(n => n.id !== 'b') });
  assert.ok(model.links.every(l => l.to !== 'note:b' && l.from !== 'note:b'), 'deleted and unresolved targets disappear');
  assert.deepEqual(network({ notes: [] }), { nodes: [], links: [], warnings: [] });
  const cached = module.exports.createNoteNetwork();
  const first = cached({ root: 'vault', notes });
  const repeated = cached({ root: 'vault', notes: notes.map(n => ({ ...n })) });
  assert.strictEqual(repeated.links[0], first.links[0], 'unchanged links are reused across polls');
  const reordered = cached({ root: 'vault', notes: [...notes].reverse() });
  assert.strictEqual(reordered.links.find(l => l.id === first.links[0].id), first.links[0], 'sorting by modification date does not invalidate the resolver');
  const edited = notes.map(n => n.id === 'b' ? { ...n, body: '[[독립]]' } : n);
  const changed = cached({ root: 'vault', notes: edited });
  assert.strictEqual(changed.links[0], first.links[0], 'editing another note preserves unchanged links');
  assert.ok(changed.links.some(l => l.from === 'note:b' && l.to === 'note:d'));
  const added = cached({ root: 'vault', notes: [...edited, note('h', '없는 노트.md')] });
  assert.ok(added.links.some(l => l.from === 'note:a' && l.to === 'note:h'), 'a new target resolves previously missing links');
  const moved = cached({ root: 'vault', notes: edited.map(n => n.id === 'b' ? { ...n, path: 'moved.md', title: 'moved' } : n) });
  assert.ok(!moved.links.some(l => l.to === 'note:b'), 'rename invalidates references');
  const ambiguous = cached({ root: 'vault', notes: [...edited, note('i', 'another/독립.md')] });
  // Exact root path has priority even when a title exists in multiple folders.
  assert.ok(ambiguous.links.some(l => l.to === 'note:d'));
  const reset = cached({ root: 'other-vault', notes: [] });
  assert.equal(reset.links.length, 0);
  console.log('PASS: wiki and Markdown references, aliases, anchors, Unicode paths, ambiguity, code/image/external exclusions, deduplication, isolated notes and deletion');
})().catch(e => { console.error(e); process.exitCode = 1; });
