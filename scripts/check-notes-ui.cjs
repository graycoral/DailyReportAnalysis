// End-to-end notes checks against an isolated offline Windows viewer.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { spawn } = require("node:child_process"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "build", "notes-ui");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "avhub-notes-test-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let viewer, browser, page;
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Timed out waiting for condition");
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const version = fs
    .readFileSync(path.join(root, "internal/hub/model.go"), "utf8")
    .match(/\bVersion\s*=\s*"([^"]+)"/)[1];
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      owner: "graycoral",
      repo: "DailyReportAnalysis",
      branch: "main",
      sync_time: "08:00",
      configured: true,
      offline: true,
      github_choice_version: version,
    }),
  );
  viewer = spawn(
    process.env.AV_NOTES_VIEWER || path.join(root, "build", "notes-viewer.exe"),
    ["--no-browser", "--data-dir", profile],
    { windowsHide: true, stdio: "ignore" },
  );
  viewer.on("exit", (code, signal) =>
    console.log("Viewer exited:", code, signal),
  );
  const instanceFile = path.join(profile, "instance-viewer.json");
  await waitFor(() => fs.existsSync(instanceFile));
  const instance = JSON.parse(fs.readFileSync(instanceFile, "utf8"));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    }),
    errors = [];
  page = await context.newPage();
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("PAGE ERROR:", e.message);
  });
  page.on("requestfailed", (request) =>
    console.error(
      "Request failed:",
      new URL(request.url()).pathname,
      request.failure()?.errorText,
    ),
  );
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      msg.text().includes("Content Security Policy")
    )
      errors.push(msg.text());
  });

  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    instance.address + "/open?key=" + encodeURIComponent(instance.key),
  );
  await page.waitForFunction(
    () => typeof state !== "undefined" && state?.config?.configured,
  );
  await page
    .locator("#report-input")
    .setInputFiles(
      path.join(
        root,
        "data/reports/2026-10-14/autonomous_driving_daily_2026-10-14.md",
      ),
    );
  await page.locator("#results .report-card").first().waitFor();
  console.log("Stage: initial report loaded");
  const api = (op = "", body) =>
    page.evaluate(
      async ({ op, body }) => {
        const r = await fetch(
          "/api/notes" + (op ? "/" + op : ""),
          body === undefined
            ? {}
            : {
                method: "POST",
                headers: {
                  "X-AV-Request": "1",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
              },
        );
        if (!r.ok) throw Error(await r.text());
        return r.json();
      },
      { op, body },
    );
  const saved = () =>
    page.waitForFunction(() =>
      document
        .querySelector("#note-status")
        ?.textContent.startsWith("저장 완료"),
    );
  await page.locator("#tab-notes").click();
  await page.locator("#note-new").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#note-document").inert &&
      document.querySelector("#note-title").value ===
        "\uC81C\uBAA9 \uC5C6\uC74C",
  );
  await page.locator("#note-title").fill("기업 분석");
  await page.locator("#note-tags").fill("분석, 회의");
  const input = page.locator("#note-editor .cm-content");
  // Use real keyboard input. Playwright's contenteditable fill uses execCommand,
  // which can inject inherited inline styles into syntax-highlighted content.
  const edit = async (text) => {
    await input.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(text);
  };
  await edit(
    "# 분석 제목\n\n**중요한 내용**과 한글 메모\n\n- [x] 확인 완료\n\n| 기업 | 내용 |\n| --- | --- |\n| A | 검토 |",
  );
  await saved();
  let listing = await api(),
    first = listing.notes.find((n) => n.title === "기업 분석");
  assert.ok(first);
  assert.ok(
    fs
      .readFileSync(path.join(profile, "notes", first.path), "utf8")
      .includes("**중요한 내용**"),
  );
  assert.equal(
    await page.locator("#note-preview h1").textContent(),
    "분석 제목",
  );
  assert.equal(
    await page.locator("#note-preview strong").textContent(),
    "중요한 내용",
  );
  assert.equal(await page.locator("#note-preview table").count(), 1);
  await page.locator("#note-mode").selectOption("live");
  await input.click();
  await page.keyboard.press("Control+End");
  await page.waitForFunction(
    () => document.querySelectorAll(".note-live-block").length > 0,
  );
  await page.locator(".note-live-block").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\nLive edit");
  await saved();
  await page.keyboard.press("Control+z");
  await saved();
  assert.ok(
    !(await api()).notes
      .find((n) => n.id === first.id)
      .body.includes("Live edit"),
  );
  await page.locator("#note-mode").selectOption("split");
  await page.locator("#note-image-input").setInputFiles({
    name: "capture.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5kAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await saved();
  await page.waitForFunction(
    () => document.querySelector("#note-preview img")?.complete,
  );
  assert.equal(
    await page.locator("#note-preview img").evaluate((img) => img.naturalWidth),
    1,
  );
  console.log("Stage: editor, undo and images passed");
  // Wiki references, backlinks and move-safe images.
  await page.locator("#note-new").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#note-document").inert &&
      document.querySelector("#note-title").value ===
        "\uC81C\uBAA9 \uC5C6\uC74C",
  );
  await page.locator("#note-title").fill("회의");
  await edit("[[기업 분석]]\n\n#회의");
  await saved();
  let second = (await api()).notes.find((n) => n.title === "회의");
  await page.locator("#note-preview [data-note-link]").click();
  await page.waitForFunction(
    () => document.querySelector("#note-title").value === "기업 분석",
  );
  assert.equal(
    await page.locator("#note-backlinks [data-backlink]").count(),
    1,
  );
  await page.locator("#note-title").fill("기업 종합 분석");
  await page.locator("#note-folder").fill("기업");
  await saved();
  listing = await api();
  first = listing.notes.find((n) => n.id === first.id);
  assert.equal(first.path, "기업/기업 종합 분석.md");
  assert.ok(first.body.includes("../"));
  assert.ok(
    listing.notes
      .find((n) => n.id === second.id)
      .body.includes("[[기업/기업 종합 분석]]"),
  );
  // Report association survives file serialization and is discoverable from reports.
  const choice = await page
    .locator("#note-report-choice option")
    .nth(1)
    .getAttribute("value");
  await page.locator("#note-report-choice").selectOption(choice);
  await page.locator("#note-report-add").click();
  await saved();
  assert.ok(
    (await api()).notes.find((n) => n.id === first.id).reports.includes(choice),
  );
  await page.locator("[data-note-report]").first().click();
  await page.locator(".report-note-list [data-open-note]").first().waitFor();
  await page.locator(".note-from-report").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#note-title").value.endsWith("메모") &&
      !document.querySelector("#note-document").inert,
  );
  assert.ok(
    (await api()).notes.some(
      (n) => n.title.endsWith("메모") && n.reports.includes(choice),
    ),
  );
  await page.locator(`[data-note-id="${first.id}"]`).click();
  await page.waitForFunction(
    () =>
      document.querySelector("#note-title").value === "기업 종합 분석" &&
      !document.querySelector("#note-document").inert,
  );
  console.log("Stage: links and reports passed");
  // External edits load when clean, but must never replace dirty editor content.
  let file = path.join(profile, "notes", first.path);
  fs.appendFileSync(file, "\n외부 변경");
  await page.waitForFunction(
    () =>
      document
        .querySelector("#note-editor .cm-content")
        .textContent.includes("외부 변경"),
    {},
    { timeout: 12000 },
  );
  let held;
  await page.route("**/api/notes/save", async (route) => {
    held = route;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await edit("내 수정 내용");
  fs.appendFileSync(file, "\n다른 창 수정");
  await page.locator("#note-save").click();
  await page.locator("#note-conflict").waitFor();
  assert.ok(fs.readFileSync(file, "utf8").includes("다른 창 수정"));
  assert.equal(await input.textContent(), "내 수정 내용");
  await page.unroute("**/api/notes/save");
  await page.locator("#note-conflict").click();
  await page.locator("#note-conflict-copy").click();
  await page.locator("#note-dialog").waitFor({ state: "hidden" });
  assert.ok(
    (await api()).notes.some(
      (n) => n.title.includes("내 수정본") && n.body === "내 수정 내용",
    ),
  );
  // Failed saves retain content and prevent switching away.
  await page.route("**/api/notes/save", (route) =>
    route.fulfill({ status: 500, body: "테스트 저장 실패" }),
  );
  await edit("저장 실패 후 유지");
  await page.locator("#tab-search").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#note-status")
      .textContent.includes("테스트 저장 실패"),
  );
  assert.equal(
    await page.locator("#viewer").getAttribute("data-view"),
    "notes",
  );
  assert.equal(await input.textContent(), "저장 실패 후 유지");
  await page.unroute("**/api/notes/save");
  await page.locator("#note-save").click();
  await saved();
  console.log("Stage: conflict and failed saves passed");
  // History restores content, while deleting and restoring retains the same ID.
  await edit("복구 대상 이전 내용");
  await saved();
  await edit("복구 전 최신 내용");
  await saved();
  await page.locator("#note-history").click();
  await page.locator("[data-note-revision]").first().click();
  await page.locator("#note-dialog").waitFor({ state: "hidden" });
  assert.equal(await input.textContent(), "복구 대상 이전 내용");
  const title = await page.locator("#note-title").inputValue();
  await page.locator("#note-delete").click();
  await page.locator("#note-delete-confirm").click();
  await page.locator("#note-dialog").waitFor({ state: "hidden" });
  await page.locator("#note-trash").click();
  await page.locator("[data-restore-note]").first().click();
  await page.locator("#note-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#note-title").inputValue(), title);
  await page.locator("#note-import-input").setInputFiles({
    name: "외부 노트.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 가져온 문서\n\n정상"),
  });
  await page.waitForFunction(
    () => document.querySelector("#note-title").value === "외부 노트",
  );
  // Korean composition does not trigger an intermediate save.
  await input.dispatchEvent("compositionstart");
  await edit("한글 조합 확인");
  await sleep(1200);
  assert.notEqual(
    (await api()).notes.find((n) => n.title === "외부 노트").body,
    "한글 조합 확인",
  );
  await input.dispatchEvent("compositionend");
  await saved();
  assert.equal(
    (await api()).notes.find((n) => n.title === "외부 노트").body,
    "한글 조합 확인",
  );
  for (const theme of ["apple", "apple-dark", "classic"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.waitForTimeout(250); // Settle the host's 150–180ms theme transitions.
    await page.screenshot({ path: path.join(out, theme + ".png") });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  for (const width of [850, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: path.join(out, width + ".png"),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "overflow " + width,
    );
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator("#note-storage").click();
  const vault = path.join(profile, "other-vault");
  await page.locator("#note-root-form input").fill(vault);
  await page
    .locator(
      '#note-root-form button[type="submit"], #note-root-form button.primary',
    )
    .click();
  await page.locator("#note-dialog").waitFor({ state: "hidden" });
  assert.equal((await api()).root, vault);
  assert.ok(fs.existsSync(file));
  // The notes and chosen storage directory survive a complete viewer restart.
  await api("root", { root: path.join(profile, "notes") });
  await page.evaluate(async () => {
    await fetch("/api/exit", {
      method: "POST",
      headers: { "X-AV-Request": "1", "Content-Type": "application/json" },
      body: "{}",
    });
  });
  await waitFor(() => viewer.exitCode !== null);
  viewer = spawn(
    process.env.AV_NOTES_VIEWER || path.join(root, "build", "notes-viewer.exe"),
    ["--no-browser", "--data-dir", profile],
    { windowsHide: true, stdio: "ignore" },
  );
  await waitFor(() => fs.existsSync(instanceFile));
  const restarted = JSON.parse(fs.readFileSync(instanceFile, "utf8"));
  await page.goto(
    restarted.address + "/open?key=" + encodeURIComponent(restarted.key),
  );
  await page.locator("#tab-notes").click();
  await page.locator("[data-note-id]").first().waitFor();
  assert.equal((await api()).root, path.join(profile, "notes"));
  assert.ok(
    (await api()).notes.some(
      (n) => n.title === "외부 노트" && n.body === "한글 조합 확인",
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: actual MD autosave, source/split/read/live editor, undo, images, tags, backlinks, rename/move, reports, external changes/conflicts, failed saves, history, trash, imports, composition, three themes, responsive layout, folder switching.",
  );
})()
  .catch(async (e) => {
    if (page) {
      await page.screenshot({
        path: path.join(out, "failure.png"),
        fullPage: true,
      });
      console.error((await page.locator("body").innerText()).slice(0, 2200));
    }
    console.error(
      String(e.stack || e).replace(/([?&]key=)[a-f0-9]+/g, "$1[redacted]"),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (viewer && viewer.exitCode === null) viewer.kill();
    console.log("Test evidence: " + out);
    console.log("Isolated profile: " + profile);
  });
