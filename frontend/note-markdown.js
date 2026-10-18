import MarkdownIt from "markdown-it";
export const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function normalizePath(value) {
  const parts = [];
  for (const p of value.replaceAll("\\", "/").split("/")) {
    if (p === "..") {
      if (!parts.length) return "";
      parts.pop();
    } else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}
export const dirname = (p) =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
export function relativePath(from, to) {
  const a = dirname(from).split("/").filter(Boolean),
    b = to.split("/");
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => ".."), ...b].join("/");
}
const noteIndexes = new WeakMap();
export function createNoteIndex(notes) {
  const paths = new Map(), titles = new Map();
  for (const note of notes) {
    const path = note.path.toLowerCase(), title = note.title.toLowerCase();
    if (!paths.has(path)) paths.set(path, note);
    // null deliberately represents an ambiguous title.
    titles.set(title, titles.has(title) ? null : note);
  }
  return { paths, titles };
}
export function resolveNote(notes, from, target) {
  let index = notes;
  if (Array.isArray(notes)) {
    index = noteIndexes.get(notes);
    if (!index) noteIndexes.set(notes, (index = createNoteIndex(notes)));
  }
  target = target.split("|")[0].split("#")[0].trim().replace(/\.md$/i, "");
  if (!target) return null;
  for (const p of [
    normalizePath(dirname(from) + "/" + target) + ".md",
    target + ".md",
  ]) {
    const found = index.paths.get(p.toLowerCase());
    if (found) return found;
  }
  return index.titles.get(target.toLowerCase()) || null;
}
export function createMarkdown(context) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  // Markdown-it emits table alignment as inline CSS. Use classes so previews
  // also work under the host's strict Content Security Policy.
  for (const type of ["th_open", "td_open"]) {
    md.renderer.rules[type] = (tokens, i, options, env, self) => {
      const token = tokens[i],
        alignment = token.attrGet("style");
      if (alignment) {
        token.attrs = token.attrs.filter(([name]) => name !== "style");
        const value = alignment.replace("text-align:", "");
        if (["left", "right", "center"].includes(value))
          token.attrJoin("class", "note-align-" + value);
      }
      return self.renderToken(tokens, i, options);
    };
  }
  md.inline.ruler.before("link", "note-wiki", (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== "[[") return false;
    const end = state.src.indexOf("]]", state.pos + 2);
    if (end < 0 || state.src.slice(state.pos, end).includes("\n")) return false;
    if (!silent) {
      const token = state.push("note_wiki", "", 0);
      token.content = state.src.slice(state.pos + 2, end);
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.note_wiki = (tokens, i) => {
    const target = tokens[i].content,
      [name, label] = target.split("|");
    const found = resolveNote(context.notes(), context.path(), name);
    return `<a href="#notes" data-note-link="${escapeHTML(name)}" class="note-wikilink${found ? "" : " missing"}" title="${found ? "노트 열기" : "연결할 노트 만들기"}">${escapeHTML(label || name)}</a>`;
  };
  md.core.ruler.after("inline", "note-tasks", (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (
        t.type === "inline" &&
        state.tokens[i - 1]?.type === "paragraph_open" &&
        state.tokens[i - 2]?.type === "list_item_open" &&
        t.children?.[0]?.type === "text"
      ) {
        const m = t.children[0].content.match(/^\[([ xX])\]\s/);
        if (m) {
          t.children[0].content = t.children[0].content.slice(m[0].length);
          const token = new state.Token("html_inline", "", 0);
          token.content = `<input type="checkbox" disabled aria-label="체크 항목" ${m[1] !== " " ? "checked" : ""}> `;
          t.children.unshift(token);
        }
      }
    }
  });
  md.renderer.rules.image = (tokens, i) => {
    const t = tokens[i],
      src = t.attrGet("src") || "";
    if (/^(?:[a-z][\w+.-]*:|\/)/i.test(src))
      return `<span class="note-image-missing">${escapeHTML(t.content || "외부 이미지")} · 파일로 붙여넣으세요</span>`;
    let decoded;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      return "";
    }
    const file = normalizePath(dirname(context.path()) + "/" + decoded);
    if (!file || file.startsWith(".")) return "";
    return `<img src="/api/notes/asset?path=${encodeURIComponent(file)}" alt="${escapeHTML(t.content)}" loading="lazy">`;
  };
  const link =
    md.renderer.rules.link_open ||
    ((tokens, i, opts, env, self) => self.renderToken(tokens, i, opts));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const t = tokens[i],
      href = t.attrGet("href") || "";
    if (/^https?:\/\//i.test(href)) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
    } else if (!/^[a-z][\w+.-]*:/i.test(href) && /\.md(?:#.*)?$/i.test(href)) {
      let target;
      try {
        target = decodeURIComponent(href);
      } catch {
        target = href;
      }
      t.attrSet("data-note-link", target);
      t.attrSet("href", "#notes");
    } else if (!href.startsWith("#") && !href.startsWith("mailto:"))
      t.attrSet("href", "#notes");
    return link(tokens, i, opts, env, self);
  };
  const body = (text) =>
    String(text).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const render = (text) => md.render(body(text));
  // Use the preview's parser so code, escaped text, images and YAML never
  // become note relationships. Reference-style Markdown links work too.
  render.references = (text) => {
    const references = [];
    for (const block of md.parse(body(text), {})) {
      if (block.type !== "inline") continue;
      for (const token of block.children || []) {
        if (token.type === "note_wiki") {
          references.push({ target: token.content, text: `[[${token.content}]]` });
        } else if (token.type === "link_open") {
          const href = token.attrGet("href") || "";
          if (/^(?:[a-z][\w+.-]*:|\/)/i.test(href) || !/\.md(?:#.*)?$/i.test(href))
            continue;
          try {
            references.push({ target: decodeURIComponent(href), text: href });
          } catch {}
        }
      }
    }
    return references;
  };
  return render;
}
