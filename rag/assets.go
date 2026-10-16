// Package rag bundles the optional service source, never Python, model weights or user data.
package rag

import "embed"

//go:embed *.py requirements.txt
var Files embed.FS
