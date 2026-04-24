// deno-fmt-ignore-file
import { TemplateLiteralDecode } from '../template-literal/decode.mjs';
import { FromType } from './from-type.mjs';
export function FromTemplateLiteral(mapping, pattern) {
    const decoded = TemplateLiteralDecode(pattern);
    const result = FromType(mapping, decoded);
    return result;
}
