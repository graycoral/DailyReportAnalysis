import { build } from "esbuild";
import fs from "node:fs";
await build({
  entryPoints: ["frontend/notes.js"],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  outfile: "internal/hub/web/notes.js",
  minify: true,
  legalComments: "eof",
});
// License notices accompany the bundled code in the offline executable.
const packages = new Set();
for (const key of Object.keys(
  JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages,
)) {
  if (!key || key.includes("esbuild") || key.includes("playwright")) continue;
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE-MIT", "license"]) {
    const p = key + "/" + name;
    if (fs.existsSync(p)) {
      packages.add(
        key.replace("node_modules/", "") + "\n" + fs.readFileSync(p, "utf8"),
      );
      break;
    }
  }
}
fs.writeFileSync(
  "internal/hub/web/notes-licenses.txt",
  [...packages].join("\n\n----------------\n\n"),
);
