import { createMarkdown, createNoteIndex, resolveNote } from "./note-markdown.js";

const markdown = createMarkdown({ notes: () => [], path: () => "" });

// Local, explicit references only. The published company/event catalog is
// never changed by personal notes or by a matching title/tag.
export function createNoteNetwork() {
 let index, indexKey, vault;
 const cache = new Map();
 return function buildNoteNetwork(listing) {
  const notes = listing.notes;
  if (vault !== listing.root) { cache.clear(); indexKey = undefined; vault = listing.root; }
  const key = JSON.stringify(notes.map(n => [n.id, n.path, n.title]).sort((a,b) => a[0].localeCompare(b[0])));
  if (key !== indexKey) { index = createNoteIndex(notes); indexKey = key; }
  const present = new Set(notes.map(n => n.id));
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  const nodes = notes.map((note) => ({
    id: "note:" + note.id,
    kind: "note",
    label: note.title,
    ref: note,
    source: "notes",
  }));
  const links = [];
  for (const note of notes) {
    const previous = cache.get(note.id);
    const reportsKey = JSON.stringify(note.reports);
    if (previous && previous.body === note.body && previous.path === note.path && previous.reportsKey === reportsKey && previous.index === index) {
      links.push(...previous.links);
      continue;
    }
    const references = previous?.body === note.body ? previous.references : markdown.references(note.body);
    const noteLinks = [];
    const seen = new Set();
    for (const reference of references) {
      const target = resolveNote(index, note.path, reference.target);
      if (!target || target.id === note.id || seen.has(target.id)) continue;
      seen.add(target.id);
      noteLinks.push({
        id: `note-link:${note.id}:${target.id}`,
        from: "note:" + note.id,
        to: "note:" + target.id,
        label: "노트 링크",
        evidence: `${note.path} 본문에 작성한 링크: ${reference.text}`,
      });
    }
    for (const report of new Set(note.reports)) {
      noteLinks.push({
        id: `note-report:${note.id}:${report}`,
        from: "note:" + note.id,
        to: "r:" + report,
        report_id: report,
        label: "리포트 연결",
        evidence: `${note.path}의 ‘연결된 리포트’에 직접 저장한 연결입니다.`,
      });
    }
    cache.set(note.id, { body: note.body, path: note.path, reportsKey, index, references, links: noteLinks });
    links.push(...noteLinks);
  }
  return { nodes, links, warnings: listing.warnings || [] };
 };
}
export const buildNoteNetwork = createNoteNetwork();
