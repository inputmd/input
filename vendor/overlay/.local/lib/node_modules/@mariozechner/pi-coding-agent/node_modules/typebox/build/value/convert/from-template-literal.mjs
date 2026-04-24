// deno-fmt-ignore-file
import { TemplateLiteralDecode } from '../../type/engine/template-literal/index.mjs';
import { FromType } from './from-type.mjs';
export function FromTemplateLiteral(context, type, value) {
    const decoded = TemplateLiteralDecode(type.pattern);
    return FromType(context, decoded, value);
}
