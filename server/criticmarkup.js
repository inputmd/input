export function stripCriticMarkupComments(source) {
  let result = '';
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf('{>>', cursor);
    if (start === -1) {
      result += source.slice(cursor);
      break;
    }

    result += source.slice(cursor, start);
    const end = source.indexOf('<<}', start + 3);
    if (end === -1) {
      result += source.slice(start);
      break;
    }

    const body = source.slice(start + 3, end);
    if (/[\r\n]/.test(body)) {
      result += source.slice(start, end + 3);
    }

    cursor = end + 3;
  }

  return result;
}
