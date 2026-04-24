// deno-fmt-ignore-file
import { FromKey } from './from-key.mjs';
import { ParsePatternIntoTypes } from '../patterns/pattern.mjs';
import { IsTemplateLiteralFinite } from '../template-literal/is-finite.mjs';
import { TemplateLiteralDecode } from '../template-literal/decode.mjs';
import { CreateRecord } from './record-create.mjs';
export function FromTemplateKey(pattern, value) {
    const types = ParsePatternIntoTypes(pattern);
    const finite = IsTemplateLiteralFinite(types);
    const result = finite ? FromKey(TemplateLiteralDecode(pattern), value) : CreateRecord(pattern, value);
    return result;
}
