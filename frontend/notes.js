import { createNoteEditor } from "./note-editor.js";
import { buildNoteNetwork } from "./note-network.js";
import {
  createMarkdown,
  escapeHTML as esc,
  dirname,
  relativePath,
  resolveNote,
} from "./note-markdown.js";

const $ = (s) => document.querySelector(s);
let bridge = {},
  mounted = false,
  loaded = false,
  active = false,
  current = null,
  editor,
  notes = [],
  folders = [],
  root = "",
  mode = "split",
  dirty = false,
  composing = false,
  saving = null,
  timer,
  serial = 0,
  loading = false,
  conflict = false,
  modalBusy = false,
  uploading = 0,
  switching = false;
const renderMD = createMarkdown({
  notes: () => notes,
  path: () => current?.path || "제목 없음.md",
});
const page = document.createElement("section");
let listingRequest = 0,
  listSignature = "";
page.id = "notes-page";
page.hidden = true;
$("#view-panel").prepend(page);
async function api(op = "", body) {
  const response = await fetch(
    "/api/notes" + (op ? "/" + op : ""),
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AV-Request": "1" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const e = Error(await response.text());
    e.status = response.status;
    throw e;
  }
  return response.json();
}
function status(text, error = false) {
  if (!mounted) return;
  $("#note-status").textContent = text;
  $("#note-status").classList.toggle("error", error);
  $("#note-conflict").hidden = !conflict;
}
function reportList() {
  return bridge.reports?.() || [];
}
function allTags() {
  return [
    ...new Set(
      notes.flatMap((n) => [
        ...n.tags,
        ...[...n.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(
          (m) => m[1],
        ),
      ]),
    ),
  ].sort();
}
function run(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      status(e.message, true);
    }
  };
}
function mount() {
  if (mounted) return;
  mounted = true;
  page.innerHTML = `<aside class="notes-sidebar" aria-label="노트 탐색"><div class="notes-sidebar-head"><h1>노트</h1><button id="note-new" class="primary">＋ 새 노트</button></div><label class="sr-only" for="note-search">노트 제목·본문 검색</label><input id="note-search" type="search" placeholder="제목·본문 검색"><div class="notes-filter-row"><select id="note-folder-filter" aria-label="폴더 필터"><option value="">모든 폴더</option></select><button id="note-new-folder" title="폴더 만들기">＋ 폴더</button></div><select id="note-tag-filter" aria-label="태그 필터"><option value="">모든 태그</option></select><p id="note-count" class="small-note" role="status"></p><div id="note-list"></div><div class="notes-sidebar-bottom"><button id="note-import">MD 가져오기</button><button id="note-trash">휴지통</button><button id="note-storage">저장 폴더</button></div><input id="note-import-input" type="file" accept=".md,text/markdown" multiple hidden></aside>
 <section class="notes-main" aria-label="노트 작성"><div class="notes-topbar"><span id="note-status" role="status" aria-live="polite">노트를 선택하세요.</span><button id="note-save">지금 저장</button><button id="note-conflict" hidden>변경 내용 비교</button><select id="note-mode" aria-label="노트 보기 모드"><option value="source">원문 편집</option><option value="split">분할 미리보기</option><option value="read">읽기</option><option value="live">Live Preview</option></select></div>
 <div id="note-empty" class="empty"><h2>리포트에서 생각으로</h2><p>새 노트를 만들고 분석과 아이디어를 기록하세요.<br>작성한 내용은 이 PC의 Markdown 파일로 저장됩니다.</p><button id="note-empty-new" class="primary">첫 노트 작성</button></div>
 <div id="note-document" hidden><div class="note-heading"><label class="sr-only" for="note-title">노트 제목</label><input id="note-title" placeholder="제목 없음" maxlength="120"><div class="note-meta"><label>폴더 <input id="note-folder" list="note-folder-options" placeholder="최상위 폴더"></label><datalist id="note-folder-options"></datalist><label>태그 <input id="note-tags" placeholder="회의, 기업분석"></label><button id="note-history">이전 저장본</button><button id="note-delete" class="note-delete">삭제</button></div></div>
 <div class="note-toolbar" role="toolbar" aria-label="노트 서식"><button data-format="heading" title="제목">제목</button><button data-format="bold" title="굵게"><b>B</b></button><button data-format="italic" title="기울임"><i>I</i></button><button data-format="list">목록</button><button data-format="task">체크박스</button><button data-format="table">표</button><button data-format="link">링크</button><button data-format="wiki">노트 연결</button><button data-format="code">코드</button><button id="note-image">이미지</button><button id="note-undo" aria-label="실행 취소">↶</button><button id="note-redo" aria-label="다시 실행">↷</button><input id="note-image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></div>
 <div class="note-writing" data-mode="split"><section class="note-editor-pane" aria-label="Markdown 편집"><div class="note-pane-label" id="note-editor-label">MARKDOWN</div><div id="note-editor"></div></section><section class="note-preview-pane" aria-label="노트 미리보기"><div class="note-pane-label">미리보기</div><article id="note-preview" class="markdown"></article></section></div>
 <footer class="note-connections"><div><h2>연결된 리포트</h2><div class="note-report-add"><select id="note-report-choice" aria-label="연결할 리포트"></select><button id="note-report-add">연결</button></div><div id="note-reports"></div></div><div><h2>이 노트를 참조하는 노트</h2><div id="note-backlinks"></div></div></footer></div></section>`;
  const dialog = document.createElement("dialog");
  dialog.id = "note-dialog";
  dialog.setAttribute("aria-labelledby", "note-dialog-title");
  dialog.innerHTML =
    '<div class="dialog-title"><h2 id="note-dialog-title"></h2><button id="note-dialog-close" aria-label="닫기">×</button></div><div id="note-dialog-body"></div><p id="note-dialog-feedback" role="status"></p>';
  document.body.append(dialog);
  $("#note-dialog-close").onclick = () => {
    if (!modalBusy) dialog.close();
  };
  dialog.addEventListener("cancel", (e) => {
    if (modalBusy) e.preventDefault();
  });
  editor = createNoteEditor($("#note-editor"), {
    render: renderMD,
    notes: () => notes,
    tags: allTags,
    mode: () => mode,
    save: flush,
    change: () => changed(),
    composition(value) {
      composing = value;
      if (!value && dirty) schedule();
    },
    images: (files) => run(() => images(files))(),
    files: (files) => run(() => filesDropped(files))(),
  });
  $("#note-new").onclick = run(() => newNote());
  $("#note-empty-new").onclick = run(() => newNote());
  $("#note-save").onclick = flush;
  $("#note-conflict").onclick = run(compare);
  $("#note-search").oninput = renderList;
  $("#note-folder-filter").onchange = renderList;
  $("#note-tag-filter").onchange = renderList;
  $("#note-title").oninput = changed;
  $("#note-folder").oninput = changed;
  $("#note-tags").oninput = changed;
  $("#note-mode").onchange = (e) => setMode(e.target.value);
  $("#note-new-folder").onclick = () =>
    showDialog(
      "새 폴더",
      '<form id="note-folder-form"><label>폴더 이름<input name="folder" required placeholder="기업 분석 / 회의"></label><button class="primary">만들기</button></form>',
      () => {
        $("#note-folder-form").onsubmit = dialogAction(async (e) => {
          e.preventDefault();
          await api("folder", { path: e.target.folder.value.trim() });
          await reload();
          $("#note-dialog").close();
        });
      },
    );
  $("#note-storage").onclick = run(storage);
  $("#note-trash").onclick = run(trash);
  $("#note-history").onclick = run(history);
  $("#note-delete").onclick = run(remove);
  $("#note-import").onclick = () => $("#note-import-input").click();
  $("#note-import-input").onchange = run(async (e) => {
    await importFiles([...e.target.files]);
    e.target.value = "";
  });
  $("#note-image").onclick = () => $("#note-image-input").click();
  $("#note-image-input").onchange = run(async (e) => {
    await images([...e.target.files]);
    e.target.value = "";
  });
  $("#note-undo").onclick = () => editor.undo();
  $("#note-redo").onclick = () => editor.redo();
  page
    .querySelectorAll("[data-format]")
    .forEach((b) => (b.onclick = () => format(b.dataset.format)));
  $("#note-report-add").onclick = () => {
    const id = $("#note-report-choice").value;
    if (id && !current.reports.includes(id)) {
      current.reports.push(id);
      changed();
      renderConnections();
    }
  };
  page.addEventListener(
    "click",
    run(async (e) => {
      const link = e.target.closest("[data-note-link]");
      if (link) {
        e.preventDefault();
        await openLink(link.dataset.noteLink);
      }
    }),
  );
  page.addEventListener("dragover", (e) => e.preventDefault());
  page.addEventListener(
    "drop",
    run(async (e) => {
      if (e.dataTransfer.files.length) {
        e.preventDefault();
        e.stopPropagation();
        await filesDropped([...e.dataTransfer.files]);
      }
    }),
  );
  page.addEventListener("compositionstart", () => (composing = true));
  page.addEventListener("compositionend", () => {
    composing = false;
    if (dirty) schedule();
  });
  try {
    const saved = localStorage.getItem("av_note_mode");
    if (["source", "split", "read", "live"].includes(saved)) mode = saved;
  } catch {}
  setMode(mode);
}
function showDialog(title, body, bind) {
  $("#note-dialog-title").textContent = title;
  $("#note-dialog-body").innerHTML = body;
  $("#note-dialog-feedback").textContent = "";
  if (!$("#note-dialog").open) $("#note-dialog").showModal();
  bind?.();
}
function dialogAction(fn) {
  return async (e) => {
    e?.preventDefault();
    if (modalBusy) return;
    modalBusy = true;
    $("#note-dialog")
      .querySelectorAll("button")
      .forEach((b) => (b.disabled = true));
    try {
      await fn(e);
    } catch (err) {
      $("#note-dialog-feedback").textContent = err.message;
    } finally {
      modalBusy = false;
      $("#note-dialog")
        .querySelectorAll("button")
        .forEach((b) => (b.disabled = false));
    }
  };
}
function setMode(value) {
  mode = value;
  $("#note-mode").value = value;
  $(".note-writing").dataset.mode = value;
  $("#note-editor-label").textContent =
    value === "live" ? "LIVE PREVIEW · 클릭한 문단을 편집합니다" : "MARKDOWN";
  editor?.mode(value);
  try {
    localStorage.setItem("av_note_mode", value);
  } catch {}
}
function renderList() {
  const query = $("#note-search")
      .value.trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean),
    folder = $("#note-folder-filter").value,
    tag = $("#note-tag-filter").value;
  const filtered = notes.filter(
    (n) =>
      (!folder || n.path.startsWith(folder + "/")) &&
      (!tag ||
        n.tags.includes(tag) ||
        [...n.body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].some(
          (m) => m[1] === tag,
        )) &&
      query.every((q) =>
        (n.title + " " + n.body + " " + n.tags.join(" "))
          .toLocaleLowerCase()
          .includes(q),
      ),
  );
  $("#note-count").textContent = `${filtered.length}개 노트 · 최근 수정순`;
  const signature = JSON.stringify([
    current?.id,
    filtered.map((n) => [n.id, n.version, n.path, n.modified]),
  ]);
  if (signature === listSignature) return;
  listSignature = signature;
  const focusedID = $("#note-list").contains(document.activeElement)
    ? document.activeElement.dataset.noteId
    : null;
  $("#note-list").innerHTML =
    filtered
      .map(
        (n) =>
          `<button class="note-list-item${current?.id === n.id ? " selected" : ""}" data-note-id="${esc(n.id)}" aria-current="${current?.id === n.id ? "page" : "false"}"><strong>${esc(n.title)}</strong><span>${esc(dirname(n.path) || "최상위 폴더")} · ${new Date(n.modified).toLocaleDateString("ko-KR")}</span><small>${esc(
            n.body
              .replace(/^---\n[\s\S]*?\n---\n/, "")
              .replace(/[#*`\[\]]/g, "")
              .slice(0, 75) || "아직 내용이 없습니다.",
          )}</small>${n.tags.length ? `<span>${n.tags.map((t) => "#" + esc(t)).join(" ")}</span>` : ""}</button>`,
      )
      .join("") ||
    '<p class="small-note notes-list-empty">조건에 맞는 노트가 없습니다.</p>';
  $("#note-list")
    .querySelectorAll("[data-note-id]")
    .forEach((b) => (b.onclick = run(() => openNote(b.dataset.noteId))));
  if (focusedID)
    $("#note-list")
      .querySelector(`[data-note-id="${focusedID}"]`)
      ?.focus({ preventScroll: true });
}
function renderFilters() {
  const folder = $("#note-folder-filter").value,
    tag = $("#note-tag-filter").value;
  $("#note-folder-filter").innerHTML =
    '<option value="">모든 폴더</option>' +
    folders.map((f) => `<option>${esc(f)}</option>`).join("");
  $("#note-folder-filter").value = folders.includes(folder) ? folder : "";
  $("#note-folder-options").innerHTML = folders
    .map((f) => `<option value="${esc(f)}"></option>`)
    .join("");
  const tags = allTags();
  $("#note-tag-filter").innerHTML =
    '<option value="">모든 태그</option>' +
    tags.map((t) => `<option>${esc(t)}</option>`).join("");
  $("#note-tag-filter").value = tags.includes(tag) ? tag : "";
}
async function reload() {
  const request = ++listingRequest;
  const data = await api();
  if (request !== listingRequest) return data;
  notes = data.notes;
  folders = data.folders;
  root = data.root;
  loaded = true;
  renderFilters();
  renderList();
  if (data.warnings.length) status(data.warnings.join(" / "), true);
  return data;
}
async function show() {
  active = true;
  page.hidden = false;
  mount();
  if (loading) return;
  loading = true;
  try {
    await reload();
    if (!current && notes.length && !switching) await openNote(notes[0].id);
    else if (current) renderConnections();
  } catch (e) {
    status(e.message, true);
  } finally {
    loading = false;
  }
}
function hide() {
  active = false;
  page.hidden = true;
}
function payload() {
  const title = $("#note-title").value.trim() || "제목 없음",
    folder = $("#note-folder")
      .value.trim()
      .replaceAll("\\", "/")
      .replace(/\/$/, "");
  return {
    id: current.id,
    path: (folder ? folder + "/" : "") + title + ".md",
    body: editor.text(),
    tags: $("#note-tags")
      .value.split(/[,，]/)
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean),
    reports: [...current.reports],
    version: current.version,
  };
}
function updatePreview() {
  if (current) $("#note-preview").innerHTML = renderMD(editor.text());
}
function changed() {
  if (!current) return;
  dirty = true;
  serial++;
  status(
    conflict ? "외부 변경이 있습니다. 비교 후 저장하세요." : "저장 대기 중…",
    conflict,
  );
  if (!composing) updatePreview();
  schedule();
}
function schedule() {
  clearTimeout(timer);
  if (!composing && !conflict) timer = setTimeout(flush, 900);
}
async function flush() {
  clearTimeout(timer);
  if (saving) {
    await saving;
    if (dirty && !conflict) return flush();
    return !dirty;
  }
  if (composing || uploading) {
    status(
      composing
        ? "한글 입력을 마친 뒤 저장합니다."
        : "이미지 첨부를 마친 뒤 저장합니다.",
    );
    schedule();
    return false;
  }
  if (!dirty) return true;
  if (conflict) {
    status("외부 변경을 비교한 뒤 저장하세요.", true);
    return false;
  }
  const runSerial = serial,
    input = payload();
  status("저장 중…");
  saving = (async () => {
    try {
      const saved = await api("save", input);
      const reports = [...current.reports];
      current = {
        ...saved,
        reports: serial === runSerial ? saved.reports : reports,
      };
      if (serial === runSerial) {
        dirty = false;
        if (editor.text() !== saved.body) editor.setText(saved.body);
        $("#note-folder").value = dirname(saved.path);
        $("#note-title").value = saved.title;
        $("#note-tags").value = saved.tags.join(", ");
        updatePreview();
        status(
          "저장 완료 · " +
            new Date().toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            }),
        );
      } else status("추가 변경 저장 대기 중…");
      await reload();
      renderConnections();
      return true;
    } catch (e) {
      if (e.status === 409) conflict = true;
      status(e.message, true);
      return false;
    } finally {
      saving = null;
    }
  })();
  const ok = await saving;
  if (ok && dirty) return flush();
  return ok;
}
function loadDocument(n) {
  current = { ...n, reports: [...n.reports] };
  dirty = false;
  conflict = false;
  serial++;
  $("#note-title").value = n.title;
  $("#note-folder").value = dirname(n.path);
  $("#note-tags").value = n.tags.join(", ");
  editor.setText(n.body);
  $("#note-empty").hidden = true;
  $("#note-document").hidden = false;
  status("저장 완료 · " + new Date(n.modified).toLocaleString("ko-KR"));
  updatePreview();
  renderList();
  renderConnections();
}
async function switchDocument(fn) {
  if (switching) return;
  switching = true;
  $("#note-document").inert = true;
  $("#note-new").disabled = true;
  try {
    return await fn();
  } finally {
    switching = false;
    $("#note-document").inert = false;
    $("#note-new").disabled = false;
  }
}
async function openNote(id) {
  return switchDocument(async () => {
    if (!(await flush())) return;
    const n = await api("get?id=" + encodeURIComponent(id));
    loadDocument(n);
  });
}
function uniquePath(name, folder = "") {
  let base = (folder ? folder + "/" : "") + name + ".md",
    p = base,
    i = 2;
  while (notes.some((n) => n.path.toLowerCase() === p.toLowerCase()))
    p = base.slice(0, -3) + " " + i++ + ".md";
  return p;
}
async function newNote(report, target) {
  mount();
  await switchDocument(async () => {
    if (!loaded) await reload();
    if (!(await flush())) return;
    const path = target
      ? target.replace(/\.md$/i, "") + ".md"
      : uniquePath(
          report
            ? report.title.replace(/[<>:"/\\|?*]/g, " ").slice(0, 80) + " 메모"
            : "제목 없음",
          $("#note-folder-filter").value,
        );
    const n = await api("save", {
      path,
      body: "",
      reports: report ? [report.id] : [],
      tags: [],
    });
    await reload();
    loadDocument(n);
  });
  $("#note-title").focus();
  $("#note-title").select();
}
function renderConnections() {
  if (!current) return;
  const reports = reportList();
  const choice = $("#note-report-choice").value;
  $("#note-report-choice").innerHTML =
    '<option value="">리포트를 선택하세요</option>' +
    reports
      .filter((r) => !current.reports.includes(r.id))
      .map(
        (r) =>
          `<option value="${esc(r.id)}">${esc(r.date)} · ${esc(r.title)}</option>`,
      )
      .join("");
  if (reports.some((r) => r.id === choice && !current.reports.includes(r.id)))
    $("#note-report-choice").value = choice;
  $("#note-reports").innerHTML =
    current.reports
      .map((id) => {
        const r = reports.find((r) => r.id === id);
        return `<div class="note-connection-row"><button data-note-report="${esc(id)}" ${r ? "" : "disabled"}>${esc(r?.title || "현재 목록에 없는 리포트")} <small>${esc(r?.date || id)}</small></button><button data-unlink-report="${esc(id)}" aria-label="${esc(r?.title || id)} 연결 해제">해제</button></div>`;
      })
      .join("") ||
    '<p class="small-note">분석의 근거가 되는 리포트를 연결하세요.</p>';
  $("#note-reports")
    .querySelectorAll("[data-note-report]")
    .forEach(
      (b) =>
        (b.onclick = run(async () => {
          if (await flush()) bridge.openReport?.(b.dataset.noteReport);
        })),
    );
  $("#note-reports")
    .querySelectorAll("[data-unlink-report]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          current.reports = current.reports.filter(
            (id) => id !== b.dataset.unlinkReport,
          );
          changed();
          renderConnections();
        }),
    );
  const back = notes.filter(
    (n) =>
      n.id !== current.id &&
      [...n.body.matchAll(/\[\[([^\]\n]+)\]\]/g)].some(
        (m) => resolveNote(notes, n.path, m[1])?.id === current.id,
      ),
  );
  $("#note-backlinks").innerHTML =
    back
      .map(
        (n) =>
          `<button class="note-backlink" data-backlink="${esc(n.id)}">${esc(n.title)}<small>${esc(n.path)}</small></button>`,
      )
      .join("") ||
    '<p class="small-note">다른 노트에서 [[노트 이름]]으로 연결하면 표시됩니다.</p>';
  $("#note-backlinks")
    .querySelectorAll("[data-backlink]")
    .forEach((b) => (b.onclick = run(() => openNote(b.dataset.backlink))));
}
async function openLink(target) {
  const n = resolveNote(notes, current.path, target);
  if (n) {
    await openNote(n.id);
    return;
  }
  const name = target.split("|")[0].split("#")[0];
  showDialog(
    "연결할 노트 만들기",
    `<p>‘${esc(name)}’ 노트가 없습니다.</p><button id="note-create-link" class="primary">노트 만들기</button>`,
    () => {
      $("#note-create-link").onclick = dialogAction(async () => {
        await newNote(null, name);
        $("#note-dialog").close();
      });
    },
  );
}
function format(kind) {
  if (!current) return;
  const formats = {
    heading: ["## ", "", "제목"],
    bold: ["**", "**", "굵은 글씨"],
    italic: ["*", "*", "강조"],
    list: ["\n- ", "", "항목"],
    task: ["\n- [ ] ", "", "할 일"],
    table: ["\n| 항목 | 내용 |\n| --- | --- |\n| ", " |\n", "내용"],
    wiki: ["[[", "]]", ""],
    code: ["\n```\n", "\n```\n", "코드"],
  };
  if (kind === "link") {
    showDialog(
      "링크 삽입",
      '<form id="note-link-form"><label>표시할 글<input name="label" required></label><label>주소<input name="url" type="url" required placeholder="https://"></label><button class="primary">삽입</button></form>',
      () => {
        $("#note-link-form").onsubmit = (e) => {
          e.preventDefault();
          const u = new URL(e.target.url.value);
          if (!["http:", "https:"].includes(u.protocol)) return;
          editor.insert(
            "[" +
              e.target.label.value.replace(/[\[\]]/g, "") +
              "](" +
              u.href.replaceAll(")", "%29") +
              ")",
          );
          $("#note-dialog").close();
        };
      },
    );
    return;
  }
  if (mode === "read") setMode("source");
  editor.insert(...formats[kind]);
}
async function images(files) {
  if (!current) await newNote();
  if (!current) return;
  if (!(await flush())) return;
  const noteID = current.id;
  uploading++;
  try {
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024)
        throw Error("이미지는 10MB 이하로 선택하세요.");
      const response = await fetch("/api/notes/image", {
        method: "POST",
        headers: { "X-AV-Request": "1" },
        body: f,
      });
      if (!response.ok) throw Error(await response.text());
      const result = await response.json();
      if (current.id !== noteID)
        throw Error(
          "첨부 중 노트가 변경되었습니다. 첨부 폴더에서 이미지를 확인하세요.",
        );
      if (mode === "read") setMode("source");
      const alt = f.name.replace(/[\[\]\r\n]/g, "");
      editor.insert(
        "\n![" +
          alt +
          "](" +
          relativePath(current.path, result.path)
            .split("/")
            .map(encodeURIComponent)
            .join("/") +
          ")\n",
      );
    }
  } finally {
    uploading--;
    if (dirty) schedule();
  }
}
async function importFiles(files) {
  if (!(await flush())) return;
  let last;
  for (const f of files) {
    if (!/\.md$/i.test(f.name)) throw Error("UTF-8 .md 파일을 선택하세요.");
    if (f.size > 2 * 1024 * 1024 - 4096)
      throw Error("노트는 2MB 이하만 가져올 수 있습니다.");
    let body = new TextDecoder("utf-8", { fatal: true }).decode(
      await f.arrayBuffer(),
    );
    let tags = [],
      reports = [];
    body = body.replace(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
      (all, head) => {
        const kept = head.split(/\r?\n/).filter((line) => {
          const m = line.match(/^avhub_(id|tags|reports):\s*(.*)$/);
          if (!m) return true;
          try {
            const value = JSON.parse(m[2]);
            if (m[1] === "tags" && Array.isArray(value)) tags = value;
            if (m[1] === "reports" && Array.isArray(value)) reports = value;
            return false;
          } catch {
            return true;
          }
        });
        return kept.length ? "---\n" + kept.join("\n") + "\n---\n" : "";
      },
    );
    last = await api("save", {
      path: uniquePath(
        f.name.replace(/\.md$/i, ""),
        $("#note-folder-filter").value,
      ),
      body,
      tags,
      reports,
    });
    await reload();
  }
  if (last) loadDocument(last);
}
async function filesDropped(files) {
  const md = files.filter((f) => /\.md$/i.test(f.name)),
    imgs = files.filter((f) => f.type.startsWith("image/"));
  if (md.length) await importFiles(md);
  if (imgs.length) await images(imgs);
  if (md.length + imgs.length !== files.length)
    status(
      "노트에는 MD와 PNG·JPEG·GIF·WebP 이미지를 추가할 수 있습니다.",
      true,
    );
}
async function remove() {
  if (!current || !(await flush())) return;
  showDialog(
    "노트를 휴지통으로 이동",
    `<p>‘${esc(current.title)}’ 노트를 삭제할까요? 휴지통에서 복원할 수 있습니다.</p><button id="note-delete-confirm">휴지통으로 이동</button>`,
    () => {
      $("#note-delete-confirm").onclick = dialogAction(async () => {
        await api("delete", { id: current.id, version: current.version });
        current = null;
        dirty = false;
        conflict = false;
        $("#note-document").hidden = true;
        $("#note-empty").hidden = false;
        $("#note-dialog").close();
        await reload();
        status("휴지통으로 이동했습니다.");
        if (notes.length) await openNote(notes[0].id);
      });
    },
  );
}
async function trash() {
  const items = await api("trash");
  showDialog(
    "노트 휴지통",
    items
      .map(
        (n) =>
          `<div class="note-connection-row"><span>${esc(n.path)}<small>${new Date(n.deleted).toLocaleString("ko-KR")}</small></span><button data-restore-note="${esc(n.id)}">복원</button></div>`,
      )
      .join("") || "<p>삭제한 노트가 없습니다.</p>",
    () => {
      $("#note-dialog-body")
        .querySelectorAll("[data-restore-note]")
        .forEach(
          (b) =>
            (b.onclick = dialogAction(async () => {
              if (!(await flush())) return;
              const n = await api("restore-trash", {
                id: b.dataset.restoreNote,
              });
              await reload();
              loadDocument(n);
              $("#note-dialog").close();
            })),
        );
    },
  );
}
async function history() {
  if (!current || !(await flush())) return;
  const revs = await api("history?id=" + encodeURIComponent(current.id));
  showDialog(
    "이전 저장본 · 최근 50개",
    revs
      .map(
        (n) =>
          `<div class="note-connection-row"><span>${new Date(n.modified).toLocaleString("ko-KR")}</span><button data-note-revision="${esc(n.revision)}">이 내용으로 복구</button></div>`,
      )
      .join("") ||
      "<p>이전 저장본이 없습니다. 수정 후 저장하면 기록됩니다.</p>",
    () => {
      $("#note-dialog-body")
        .querySelectorAll("[data-note-revision]")
        .forEach(
          (b) =>
            (b.onclick = dialogAction(async () => {
              const n = await api("restore-version", {
                ...payload(),
                revision: b.dataset.noteRevision,
              });
              await reload();
              loadDocument(n);
              $("#note-dialog").close();
            })),
        );
    },
  );
}
async function storage() {
  if (!(await flush())) return;
  showDialog(
    "노트 저장 폴더",
    `<p>노트와 이미지는 선택한 폴더에 평문 파일로 보관됩니다. 폴더를 변경하면 그 위치의 노트를 엽니다. 기존 파일은 원래 폴더에 남습니다.</p><form id="note-root-form"><label>폴더 경로<input name="root" value="${esc(root)}" required></label><div class="form-actions"><button type="button" id="note-pick-root">폴더 선택</button><button class="primary">이 폴더 열기</button><button type="button" id="note-open-root">탐색기에서 보기</button></div></form>`,
    () => {
      const apply = async (op, body) => {
        const data = await api(op, body);
        if (data.cancelled) return;
        current = null;
        dirty = false;
        conflict = false;
        $("#note-document").hidden = true;
        $("#note-empty").hidden = false;
        await reload();
        if (notes.length) await openNote(notes[0].id);
        $("#note-dialog").close();
        status("노트 폴더를 변경했습니다.");
      };
      $("#note-root-form").onsubmit = dialogAction((e) =>
        apply("root", { root: e.target.root.value.trim() }),
      );
      $("#note-pick-root").onclick = dialogAction(() => apply("pick-root", {}));
      $("#note-open-root").onclick = dialogAction(() => api("open-root", {}));
    },
  );
}
async function compare() {
  if (!current) return;
  let remote;
  try {
    remote = await api("get?id=" + encodeURIComponent(current.id));
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  showDialog(
    "다른 편집기의 변경과 비교",
    `<p>내 내용을 사본으로 저장하거나, 파일의 최신 내용을 불러올 수 있습니다.</p><div class="note-compare"><div><h3>내 작성 내용</h3><pre>${esc(editor.text())}</pre></div><div><h3>파일의 최신 내용</h3><pre>${esc(remote?.body || "(파일이 삭제되었거나 이동되었습니다.)")}</pre></div></div><div class="form-actions"><button id="note-conflict-copy" class="primary">내 내용을 사본으로 저장</button><button id="note-conflict-reload" ${remote ? "" : "disabled"}>최신 내용 불러오기</button></div>`,
    () => {
      $("#note-conflict-copy").onclick = dialogAction(async () => {
        await reload();
        const input = payload();
        input.id = "";
        input.version = "";
        input.path = uniquePath(
          $("#note-title").value + " (내 수정본)",
          dirname(input.path),
        );
        const n = await api("save", input);
        await reload();
        loadDocument(n);
        $("#note-dialog").close();
      });
      $("#note-conflict-reload").onclick = dialogAction(async () => {
        loadDocument(await api("get?id=" + encodeURIComponent(current.id)));
        await reload();
        $("#note-dialog").close();
      });
    },
  );
}
async function poll() {
  if (
    !active ||
    !loaded ||
    loading ||
    switching ||
    saving ||
    composing ||
    uploading ||
    modalBusy
  )
    return;
  try {
    const id = current?.id;
    await reload();
    if (!id || current?.id !== id) return;
    const other = notes.find((n) => n.id === id);
    if (
      !other ||
      other.version !== current.version ||
      other.path !== current.path
    ) {
      if (dirty || !other) {
        conflict = true;
        clearTimeout(timer);
        status(
          other
            ? "외부에서 수정되었습니다. 변경 내용을 비교하세요."
            : "파일이 삭제되었거나 이동되었습니다. 사본으로 저장할 수 있습니다.",
          true,
        );
      } else {
        loadDocument(other);
        status("외부 편집기의 변경을 반영했습니다.");
      }
    }
    renderConnections();
  } catch (e) {
    status(e.message, true);
  }
}
setInterval(poll, 5000);
addEventListener("beforeunload", (e) => {
  if (dirty || saving || uploading) {
    e.preventDefault();
    e.returnValue = "";
    flush();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && dirty) flush();
});
window.AVNotes = {
  configure(value) {
    bridge = value;
  },
  show,
  hide,
  flush,
  hasPending: () => dirty || !!saving || uploading > 0,
  network: async () => buildNoteNetwork(await api()),
  preview: (note, items) =>
    createMarkdown({ notes: () => items, path: () => note.path })(note.body),
  async open(id, target) {
    mount();
    if (!(await flush())) return;
    await reload();
    await openNote(id);
    bridge.openNotes?.();
    if (target) await openLink(target);
  },
  async fromReport(report) {
    mount();
    if (!loaded) await reload();
    if (!(await flush())) return;
    bridge.openNotes?.();
    await newNote(report);
  },
  async attachReport(report, host) {
    const section = document.createElement("section");
    section.className = "report-notes";
    section.innerHTML =
      '<h3>연결된 노트</h3><button class="note-from-report">＋ 관련 노트 작성</button><div class="report-note-list"></div>';
    host.append(section);
    section.querySelector("button").onclick = run(() =>
      window.AVNotes.fromReport(report),
    );
    try {
      const data = await api();
      if (!section.isConnected) return;
      const linked = data.notes.filter((n) => n.reports.includes(report.id));
      section.querySelector(".report-note-list").innerHTML =
        linked
          .map(
            (n) =>
              `<button data-open-note="${esc(n.id)}">${esc(n.title)}</button>`,
          )
          .join("") ||
        '<p class="small-note">이 리포트에 연결된 노트가 없습니다.</p>';
      section.querySelectorAll("[data-open-note]").forEach(
        (b) =>
          (b.onclick = run(async () => {
            mount();
            if (!(await flush())) return;
            bridge.openNotes?.();
            await reload();
            await openNote(b.dataset.openNote);
          })),
      );
    } catch (e) {
      section.querySelector(".report-note-list").textContent = e.message;
    }
  },
  files: filesDropped,
};
