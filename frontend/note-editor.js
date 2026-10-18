import { EditorState, StateField, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  Decoration,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";

export function createNoteEditor(parent, options) {
  const live = new Compartment();
  let view;
  class PreviewBlock extends WidgetType {
    constructor(text, from) {
      super();
      this.text = text;
      this.from = from;
    }
    eq(other) {
      return this.text === other.text && this.from === other.from;
    }
    toDOM(editor) {
      const el = document.createElement("div");
      el.className = "note-live-block markdown";
      el.innerHTML = options.render(this.text);
      el.setAttribute("aria-label", "서식 미리보기 · 클릭하여 편집");
      el.addEventListener("mousedown", (e) => {
        if (e.target.closest("a,button")) return;
        e.preventDefault();
        editor.dispatch({
          selection: { anchor: this.from },
          scrollIntoView: true,
        });
        editor.focus();
      });
      el.querySelectorAll("img").forEach((img) =>
        img.addEventListener("load", () => editor.requestMeasure()),
      );
      return el;
    }
    ignoreEvent() {
      return false;
    }
  }
  function decorations(state) {
    const ranges = [],
      selection = state.selection.ranges;
    for (
      let node = syntaxTree(state).topNode.firstChild;
      node;
      node = node.nextSibling
    ) {
      const start = state.doc.lineAt(node.from).from,
        end = state.doc.lineAt(node.to).to;
      if (
        selection.some((s) => s.from <= end && s.to >= start) ||
        node.to - node.from > 50000
      )
        continue;
      const source = state.sliceDoc(node.from, node.to);
      if (node.from === 0 && source.startsWith("---")) continue;
      ranges.push(
        Decoration.replace({
          widget: new PreviewBlock(source, node.from),
          block: true,
        }).range(node.from, node.to),
      );
    }
    return Decoration.set(ranges, true);
  }
  const liveField = StateField.define({
    create: decorations,
    update(value, tr) {
      return tr.docChanged || tr.selection || tr.reconfigured
        ? decorations(tr.state)
        : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  function complete(context) {
    const wiki = context.matchBefore(/\[\[[^\]\n]*/);
    if (wiki) {
      return {
        from: wiki.from + 2,
        options: options.notes().map((n) => ({
          label: n.path.replace(/\.md$/i, ""),
          displayLabel: n.title,
          detail: n.path,
          type: "text",
          apply(v, c, from, to) {
            const suffix = v.state.sliceDoc(to, to + 2) === "]]" ? "" : "]]";
            v.dispatch({ changes: { from, to, insert: c.label + suffix } });
          },
        })),
      };
    }
    const tag = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
    if (tag)
      return {
        from: tag.from + 1,
        options: options.tags().map((t) => ({ label: t, type: "keyword" })),
      };
    return null;
  }
  const extensions = [
    markdown({ base: markdownLanguage, completeHTMLTags: false }),
    history(),
    drawSelection(),
    highlightActiveLine(),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.heading, color: "var(--ink)", fontWeight: "700" },
        { tag: tags.strong, fontWeight: "700" },
        { tag: tags.emphasis, fontStyle: "italic" },
        {
          tag: tags.link,
          color: "var(--accent-ink)",
          textDecoration: "underline",
        },
        { tag: tags.url, color: "var(--accent-ink)" },
        {
          tag: tags.monospace,
          color: "var(--ink-2)",
          backgroundColor: "var(--code-bg)",
        },
        { tag: tags.meta, color: "var(--muted)" },
        { tag: tags.processingInstruction, color: "var(--muted)" },
      ]),
    ),
    EditorView.lineWrapping,
    placeholder(
      "생각을 적어 보세요. [[노트 이름]]으로 연결하고, 이미지를 붙여넣을 수 있습니다.",
    ),
    autocompletion({ override: [complete] }),
    keymap.of([
      ...completionKeymap,
      {
        key: "Mod-s",
        run: () => {
          options.save();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.contentAttributes.of({
      "aria-label": "노트 본문",
      spellcheck: "false",
      contenteditable: "plaintext-only",
    }),
    EditorView.cspNonce.of(
      document.querySelector('meta[name="notes-style-nonce"]')?.content || "",
    ),
    live.of([]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) options.change(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      beforeinput(event, editor) {
        // Replace plain text through the editor transaction. Native replacement
        // of a highlighted selection can inject computed inline styles in Edge,
        // which the app correctly rejects through CSP. IME remains native.
        if (
          !event.isComposing &&
          event.inputType === "insertText" &&
          event.data != null
        ) {
          event.preventDefault();
          editor.dispatch({
            ...editor.state.replaceSelection(event.data),
            userEvent: "input.type",
            scrollIntoView: true,
          });
          return true;
        }
        return false;
      },
      compositionstart() {
        options.composition(true);
      },
      compositionend() {
        setTimeout(() => options.composition(false), 0);
      },
      paste(e) {
        const files = [...e.clipboardData.files].filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length) {
          e.preventDefault();
          options.images(files);
          return true;
        }
        return false;
      },
      drop(e) {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          e.stopPropagation();
          options.files([...e.dataTransfer.files]);
          return true;
        }
        return false;
      },
    }),
  ];
  view = new EditorView({
    state: EditorState.create({ doc: "", extensions }),
    parent,
  });
  return {
    view,
    text: () => view.state.doc.toString(),
    setText(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
      this.mode(options.mode());
    },
    mode(mode) {
      view.dispatch({
        effects: live.reconfigure(mode === "live" ? [liveField] : []),
      });
    },
    insert(before, after = "", fallback = "") {
      const s = view.state.selection.main,
        text = view.state.sliceDoc(s.from, s.to) || fallback;
      view.dispatch({
        changes: { from: s.from, to: s.to, insert: before + text + after },
        selection: {
          anchor: s.from + before.length,
          head: s.from + before.length + text.length,
        },
        userEvent: "input",
      });
      view.focus();
    },
    undo: () => undo(view),
    redo: () => redo(view),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
