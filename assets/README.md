# AV Report Hub icon

`av-report-hub.svg` is the editable source: a blue-to-teal tile and rounded AV monogram matching the application's existing brand colors. `av-report-hub.png` is the 256 px preview. `av-report-hub.ico` contains transparent 32-bit PNG frames at 16, 20, 24, 32, 40, 48, 64, 128, and 256 px.

After editing the SVG, run `powershell -NoProfile -File scripts/generate-icon.ps1` on Windows and commit the SVG, PNG, and ICO together. The generator supports the rectangle, two-stop gradient, and rounded polylines used here; it is not a general SVG renderer. It uses Windows System.Drawing and does not download tools or fonts.

`scripts/build.ps1` embeds the ICO into the viewer before putting that viewer inside Setup, then embeds the same ICO into Setup. `scripts/set-exe-icon.ps1` preserves other Windows resources and verifies every embedded frame plus Windows icon decoding. Run this step before any future code signing and checksum generation. The Windows CI installation smoke test also checks the installed EXE and the shortcut's explicit `IconLocation`, then restores any desktop shortcut that existed before the test.

The distributed app needs no external icon file or additional runtime.

브라우저 탭과 도움말도 `icon.go`에 포함한 같은 ICO를 `/favicon.ico`로 사용합니다. 아이콘을 변경할 때 별도 favicon 사본을 수정할 필요는 없습니다.
