package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func emptySnapshot() Snapshot {
	return Snapshot{Catalog: Catalog{Schema: 1, Reports: []Report{}, Events: []Event{}, Entities: []Entity{}, Relations: []Relation{}, Related: []Related{}}}
}

// A new installation has no published reports. Old bundled snapshots are not
// evidence of a GitHub sync; keep their files intact but do not load them.
func (a *App) loadSnapshot() {
	a.snapshot = emptySnapshot()
	if b, err := os.ReadFile(filepath.Join(a.dir, "snapshot.json")); err == nil {
		var snap Snapshot
		if json.Unmarshal(b, &snap) == nil && snap.Commit != "" && snap.Origin != "bundled" && snap.Catalog.Validate() == nil {
			a.snapshot = snap
		}
	}
}

// Caller holds mu. Preserve the cached snapshot for re-enabling, while all
// consumers see only reports from the currently enabled GitHub integration.
func (a *App) githubSnapshot() Snapshot {
	if a.snapshot.Commit == "" || a.snapshot.Origin != a.config.Owner+"/"+a.config.Repo {
		return emptySnapshot()
	}
	if !a.config.githubEnabled() {
		snap := emptySnapshot()
		snap.SyncedAt = a.snapshot.SyncedAt
		return snap
	}
	return a.snapshot
}
