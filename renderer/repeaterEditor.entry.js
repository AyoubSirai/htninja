import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  placeholder,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';

function mark(from, to, className, output) {
  if (to > from) output.push(Decoration.mark({ class: className }).range(from, to));
}

function decorateForm(source, offset, output) {
  let cursor = 0;
  let expectingName = true;
  for (const part of source.split(/([&=])/)) {
    const from = offset + cursor;
    const to = from + part.length;
    if (part === '&') {
      mark(from, to, 'cm-syntax-punctuation', output);
      expectingName = true;
    } else if (part === '=') {
      mark(from, to, 'cm-syntax-punctuation', output);
      expectingName = false;
    } else {
      mark(from, to, expectingName ? 'cm-syntax-property' : 'cm-syntax-string', output);
    }
    cursor += part.length;
  }
}

function decorateJson(source, offset, output) {
  const pattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?(?:\b\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b|[{}[\],:]/gim;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    let className = 'cm-syntax-punctuation';
    if (token.startsWith('"')) {
      className = /"\s*$/.test(token) &&
        /^\s*:/.test(source.slice(match.index + token.length))
        ? 'cm-syntax-property'
        : 'cm-syntax-string';
    } else if (/^(true|false|null)$/i.test(token)) className = 'cm-syntax-literal';
    else if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
      className = 'cm-syntax-number';
    }
    mark(offset + match.index, offset + match.index + token.length, className, output);
  }
}

function buildHttpDecorations(view) {
  const source = view.state.doc.toString();
  const output = [];
  const firstBreak = source.indexOf('\n');
  const firstEnd = firstBreak < 0 ? source.length : firstBreak;
  const firstLine = source.slice(0, firstEnd);
  const requestLine = firstLine.match(/^(\S+)(\s+)(\S+)(\s+)(HTTP\/\d(?:\.\d)?)$/i);
  if (requestLine) {
    let cursor = 0;
    mark(cursor, cursor + requestLine[1].length, 'cm-syntax-keyword', output);
    cursor += requestLine[1].length + requestLine[2].length;
    const targetStart = cursor;
    const target = requestLine[3];
    const queryIndex = target.indexOf('?');
    if (queryIndex < 0) mark(targetStart, targetStart + target.length, 'cm-syntax-string', output);
    else {
      mark(targetStart, targetStart + queryIndex, 'cm-syntax-string', output);
      mark(targetStart + queryIndex, targetStart + queryIndex + 1, 'cm-syntax-punctuation', output);
      decorateForm(target.slice(queryIndex + 1), targetStart + queryIndex + 1, output);
    }
    cursor += target.length + requestLine[4].length;
    mark(cursor, cursor + requestLine[5].length, 'cm-syntax-status', output);
  }

  const separatorMatch = /\r?\n\r?\n/.exec(source);
  const headersEnd = separatorMatch ? separatorMatch.index : source.length;
  const bodyStart = separatorMatch ? separatorMatch.index + separatorMatch[0].length : source.length;
  const headersStart = firstBreak < 0 ? source.length : firstBreak + 1;
  const headerBlock = source.slice(headersStart, headersEnd);
  let contentType = '';
  let lineOffset = headersStart;
  for (const line of headerBlock.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      mark(lineOffset, lineOffset + colon, 'cm-syntax-header-name', output);
      mark(lineOffset + colon, lineOffset + colon + 1, 'cm-syntax-punctuation', output);
      mark(lineOffset + colon + 1, lineOffset + line.length, 'cm-syntax-header-value', output);
      if (/^content-type$/i.test(line.slice(0, colon).trim())) {
        contentType = line.slice(colon + 1).trim().toLowerCase();
      }
    }
    lineOffset += line.length + 1;
  }

  const body = source.slice(bodyStart);
  const trimmed = body.trim();
  if (contentType.includes('json') || /^[{[]/.test(trimmed)) {
    decorateJson(body, bodyStart, output);
  } else if (
    contentType.includes('application/x-www-form-urlencoded') ||
    /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(trimmed)
  ) {
    decorateForm(body, bodyStart, output);
  } else if (contentType.includes('html') || /^<!?html|^</i.test(trimmed)) {
    for (const match of body.matchAll(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g)) {
      mark(bodyStart + match.index, bodyStart + match.index + match[0].length, 'cm-syntax-tag', output);
    }
  }

  output.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(output, true);
}

const httpHighlightPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildHttpDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildHttpDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

const setSearchMatches = StateEffect.define();
const searchHighlights = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSearchMatches)) continue;
      const ranges = [];
      for (let index = 0; index < effect.value.matches.length; index += 1) {
        const match = effect.value.matches[index];
        const className = index === effect.value.current
          ? 'cm-search-match cm-search-current'
          : 'cm-search-match';
        mark(match.start, match.end, className, ranges);
      }
      return Decoration.set(ranges, true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class RequestEditorAdapter {
  constructor(parent, options = {}) {
    this.inputListeners = new Set();
    this.silentUpdate = false;
    this.inputScheduled = false;
    this.editable = new Compartment();
    const isJavaScript = options.language === 'javascript';
    const editorPlaceholder = options.placeholder ||
      'GET /path HTTP/1.1\nHost: example.com\n\nRequest body';
    const languageExtensions = isJavaScript
      ? [javascript(), syntaxHighlighting(defaultHighlightStyle)]
      : [httpHighlightPlugin];
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          EditorView.cspNonce.of('smartnet'),
          EditorState.tabSize.of(4),
          indentUnit.of('    '),
          placeholder(editorPlaceholder),
          EditorView.contentAttributes.of({
            'aria-label': options.ariaLabel || 'Raw HTTP request',
            spellcheck: 'false',
          }),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          this.editable.of(EditorView.editable.of(true)),
          ...languageExtensions,
          searchHighlights,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.silentUpdate) return;
            if (this.inputScheduled) return;
            this.inputScheduled = true;
            queueMicrotask(() => {
              this.inputScheduled = false;
              for (const listener of this.inputListeners) listener(new Event('input'));
            });
          }),
        ],
      }),
    });
  }

  get value() {
    return this.view.state.doc.toString();
  }

  set value(value) {
    const next = String(value || '');
    if (next === this.value) return;
    const anchor = Math.min(this.view.state.selection.main.anchor, next.length);
    this.silentUpdate = true;
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: next },
        selection: { anchor },
      });
    } finally {
      this.silentUpdate = false;
    }
  }

  get selectionStart() {
    return this.view.state.selection.main.from;
  }

  get selectionEnd() {
    return this.view.state.selection.main.to;
  }

  get scrollTop() {
    return this.view.scrollDOM.scrollTop;
  }

  set scrollTop(value) {
    this.view.scrollDOM.scrollTop = value;
  }

  get scrollLeft() {
    return this.view.scrollDOM.scrollLeft;
  }

  set scrollLeft(value) {
    this.view.scrollDOM.scrollLeft = value;
  }

  set disabled(value) {
    this.view.dispatch({
      effects: this.editable.reconfigure(EditorView.editable.of(!value)),
    });
  }

  focus() {
    this.view.focus();
  }

  setSelectionRange(start, end) {
    this.view.dispatch({
      selection: { anchor: start, head: end },
      effects: EditorView.scrollIntoView(start, { y: 'center' }),
    });
  }

  setSearchMatches(matches, current) {
    this.view.dispatch({
      effects: setSearchMatches.of({ matches, current }),
    });
  }

  addEventListener(type, listener) {
    if (type === 'input') {
      this.inputListeners.add(listener);
      return;
    }
    const target = type === 'scroll'
      ? this.view.scrollDOM
      : type === 'focus' || type === 'blur'
        ? this.view.contentDOM
        : this.view.dom;
    target.addEventListener(type, listener);
  }
}

window.SmartNetCodeEditor = {
  create(parent) {
    return new RequestEditorAdapter(parent);
  },
  createJavaScript(parent) {
    return new RequestEditorAdapter(parent, {
      language: 'javascript',
      ariaLabel: 'Automatic response hook JavaScript',
      placeholder: `req.body = '';
res.body = res.body.replaceAll('old', 'new');`,
    });
  },
};
