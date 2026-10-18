import { createMarkdown, resolveNote } from "./note-markdown.js";

const markdown = createMarkdown({ notes: () => [], path: () => "" });

// Local, explicit references only. The published company/event catalog is
// never changed by personal notes or by a matching title/tag.
export function buildNoteNetwork(listing) {
  const notes = listing.notes;
  const nodes = notes.map((note) => ({
    id: "note:" + note.id,
    kind: "note",
    label: note.title,
    ref: note,
    source: "notes",
  }));
  const links = [];
  for (const note of notes) {
    const seen = new Set();
    for (const reference of markdown.references(note.body)) {
      const target = resolveNote(notes, note.path, reference.target);
      if (!target || target.id === note.id || seen.has(target.id)) continue;
      seen.add(target.id);
      links.push({
        id: `note-link:${note.id}:${target.id}`,
        from: "note:" + note.id,
        to: "note:" + target.id,
        label: "노트 링크",
        evidence: `${note.path} 본문에 작성한 링크: ${reference.text}`,
      });
    }
    for (const report of new Set(note.reports)) {
      links.push({
        id: `note-report:${note.id}:${report}`,
        from: "note:" + note.id,
        to: "r:" + report,
        report_id: report,
        label: "리포트 연결",
        evidence: `${note.path}의 ‘연결된 리포트’에 직접 저장한 연결입니다.`,
      });
    }
  }
  return { nodes, links, warnings: listing.warnings || [] };
}
