// Share immutable snapshots between the editor, report links and graph polls.
// Requests are serialized so a late response cannot overwrite a newer delta.
export function createNoteListing(fetchListing) {
  let snapshot, pending;
  return function listing(fresh = false) {
    if (pending) return fresh ? pending.then(() => listing()) : pending;
    pending = (async () => {
      const data = await fetchListing(snapshot?.revision || "");
      if (data.delta && snapshot && data.root === snapshot.root) {
        const items = new Map(snapshot.notes.map(note => [note.id, note]));
        for (const id of data.deleted || []) items.delete(id);
        for (const note of data.notes) items.set(note.id, note);
        const unchanged = !data.notes.length && !(data.deleted || []).length;
        snapshot = { ...data, notes: unchanged ? snapshot.notes : [...items.values()].sort((a, b) => b.modified.localeCompare(a.modified)) };
      } else snapshot = data;
      return snapshot;
    })().finally(() => { pending = null; });
    return pending;
  };
}
