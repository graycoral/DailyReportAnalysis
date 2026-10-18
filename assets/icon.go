// Package branding shares the Windows application icon with the local web UI.
package branding

import _ "embed"

// Icon is the same multi-resolution ICO stamped into the viewer and installer.
//
//go:embed av-report-hub.ico
var Icon []byte
