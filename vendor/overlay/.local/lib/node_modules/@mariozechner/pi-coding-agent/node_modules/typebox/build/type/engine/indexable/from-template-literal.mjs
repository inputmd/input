// deno-fmt-ignore-file
import { TemplateLiteralDecode } from '../template-literal/decode.mjs';
import { FromType } from './from-type.mjs';
export function FromTemplateLiteral(pattern) {
    const decoded = TemplateLiteralDecode(pattern);
    const result = FromType(decoded);
    return result;
}
