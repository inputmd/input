const ANSI_FG: Record<number, string> = {
  30: 'var(--ansi-black)', 31: 'var(--ansi-red)', 32: 'var(--ansi-green)',
  33: 'var(--ansi-yellow)', 34: 'var(--ansi-blue)', 35: 'var(--ansi-magenta)',
  36: 'var(--ansi-cyan)', 37: 'var(--ansi-white)',
  90: 'var(--ansi-bright-black)', 91: 'var(--ansi-bright-red)',
  92: 'var(--ansi-bright-green)', 93: 'var(--ansi-bright-yellow)',
  94: 'var(--ansi-bright-blue)', 95: 'var(--ansi-bright-magenta)',
  96: 'var(--ansi-bright-cyan)', 97: 'var(--ansi-bright-white)',
};

const ANSI_BG: Record<number, string> = {
  40: 'var(--ansi-black)', 41: 'var(--ansi-red)', 42: 'var(--ansi-green)',
  43: 'var(--ansi-yellow)', 44: 'var(--ansi-blue)', 45: 'var(--ansi-magenta)',
  46: 'var(--ansi-cyan)', 47: 'var(--ansi-white)',
  100: 'var(--ansi-bright-black)', 101: 'var(--ansi-bright-red)',
  102: 'var(--ansi-bright-green)', 103: 'var(--ansi-bright-yellow)',
  104: 'var(--ansi-bright-blue)', 105: 'var(--ansi-bright-magenta)',
  106: 'var(--ansi-bright-cyan)', 107: 'var(--ansi-bright-white)',
};

function color256(n: number): string {
  if (n >= 0 && n <= 7) return ANSI_FG[30 + n] ?? 'inherit';
  if (n >= 8 && n <= 15) return ANSI_FG[90 + (n - 8)] ?? 'inherit';
  if (n >= 16 && n <= 231) {
    const idx = n - 16;
    const v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[Math.floor(idx / 36)]},${v[Math.floor((idx % 36) / 6)]},${v[idx % 6]})`;
  }
  if (n >= 232 && n <= 255) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
  return 'inherit';
}

interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fg: string | null;
  bg: string | null;
}

function reset(): Style {
  return { bold: false, dim: false, italic: false, underline: false, strikethrough: false, fg: null, bg: null };
}

function hasStyle(s: Style): boolean {
  return s.bold || s.dim || s.italic || s.underline || s.strikethrough || s.fg !== null || s.bg !== null;
}

function openTag(s: Style): string {
  const css: string[] = [];
  if (s.bold) css.push('font-weight:bold');
  if (s.dim) css.push('opacity:0.7');
  if (s.italic) css.push('font-style:italic');
  const deco: string[] = [];
  if (s.underline) deco.push('underline');
  if (s.strikethrough) deco.push('line-through');
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  if (s.fg) css.push(`color:${s.fg}`);
  if (s.bg) css.push(`background-color:${s.bg}`);
  return `<span style="${css.join(';')}">`;
}

function escHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clampRgb(r: string, g: string, b: string): string {
  const clamp = (v: string) => Math.max(0, Math.min(255, parseInt(v, 10) || 0));
  return `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
}

function applyColon(part: string, s: Style) {
  const subs = part.split(':').map(x => parseInt(x, 10));
  if (subs[0] === 38 && subs[1] === 2) {
    const off = subs.length >= 6 ? 3 : 2;
    s.fg = clampRgb(String(subs[off]), String(subs[off + 1]), String(subs[off + 2]));
  } else if (subs[0] === 48 && subs[1] === 2) {
    const off = subs.length >= 6 ? 3 : 2;
    s.bg = clampRgb(String(subs[off]), String(subs[off + 1]), String(subs[off + 2]));
  } else if (subs[0] === 38 && subs[1] === 5 && subs.length >= 3) {
    s.fg = color256(subs[2]);
  } else if (subs[0] === 48 && subs[1] === 5 && subs.length >= 3) {
    s.bg = color256(subs[2]);
  }
}

function applySgr(paramStr: string, s: Style) {
  if (!paramStr || paramStr === '0') { Object.assign(s, reset()); return; }

  const parts = paramStr.split(';');
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (part.includes(':')) { applyColon(part, s); i++; continue; }

    const c = parseInt(part, 10);
    if (isNaN(c)) { i++; continue; }

    if (c === 38 && i + 1 < parts.length) {
      const m = parseInt(parts[i + 1], 10);
      if (m === 2 && i + 4 < parts.length) {
        s.fg = clampRgb(parts[i + 2], parts[i + 3], parts[i + 4]); i += 5; continue;
      } else if (m === 5 && i + 2 < parts.length) {
        s.fg = color256(parseInt(parts[i + 2], 10)); i += 3; continue;
      }
    }
    if (c === 48 && i + 1 < parts.length) {
      const m = parseInt(parts[i + 1], 10);
      if (m === 2 && i + 4 < parts.length) {
        s.bg = clampRgb(parts[i + 2], parts[i + 3], parts[i + 4]); i += 5; continue;
      } else if (m === 5 && i + 2 < parts.length) {
        s.bg = color256(parseInt(parts[i + 2], 10)); i += 3; continue;
      }
    }

    switch (c) {
      case 0: Object.assign(s, reset()); break;
      case 1: s.bold = true; break;
      case 2: s.dim = true; break;
      case 3: s.italic = true; break;
      case 4: s.underline = true; break;
      case 9: s.strikethrough = true; break;
      case 22: s.bold = false; s.dim = false; break;
      case 23: s.italic = false; break;
      case 24: s.underline = false; break;
      case 29: s.strikethrough = false; break;
      case 39: s.fg = null; break;
      case 49: s.bg = null; break;
      default:
        if (c >= 30 && c <= 37) s.fg = ANSI_FG[c] ?? null;
        else if (c >= 40 && c <= 47) s.bg = ANSI_BG[c] ?? null;
        else if (c >= 90 && c <= 97) s.fg = ANSI_FG[c] ?? null;
        else if (c >= 100 && c <= 107) s.bg = ANSI_BG[c] ?? null;
    }
    i++;
  }
}

export function parseAnsiToHtml(text: string): string {
  // Normalize line endings and strip non-SGR escape sequences
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  text = text.replace(/\x1b\[\?[\d;]*[hl]/g, '');
  text = text.replace(/\x1b\[[\d;]*[A-HJKSTfhln]/g, '');
  text = text.replace(/\x1b[()][A-Z0-9]/g, '');

  const re = /\x1b\[([\d;:]*?)m/g;
  const s = reset();
  let result = '';
  let last = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    const before = text.substring(last, match.index);
    if (before) {
      result += hasStyle(s) ? openTag(s) + escHtml(before) + '</span>' : escHtml(before);
    }
    applySgr(match[1], s);
    last = re.lastIndex;
  }

  const tail = text.substring(last);
  if (tail) {
    result += hasStyle(s) ? openTag(s) + escHtml(tail) + '</span>' : escHtml(tail);
  }
  return result;
}
