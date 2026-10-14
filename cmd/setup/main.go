package main

import (
	"avreporthub/internal/hub"
	"embed"
)

//go:embed payload/AVReportHub.exe
var payload embed.FS

func main() {
	b, err := payload.ReadFile("payload/AVReportHub.exe")
	if err != nil {
		panic(err)
	}
	hub.Run(true, b)
}
