// deno-fmt-ignore-file
import { IsLiteral } from '../../types/literal.mjs';
import { IsTemplateLiteral } from '../../types/template-literal.mjs';
import { IsUnion } from '../../types/union.mjs';
import { FromLiteral } from './from-literal.mjs';
import { FromTemplateLiteral } from './from-template-literal.mjs';
import { FromUnion } from './from-union.mjs';
export function FromType(mapping, type) {
    return (IsLiteral(type) ? FromLiteral(mapping, type.const) :
        IsTemplateLiteral(type) ? FromTemplateLiteral(mapping, type.pattern) :
            IsUnion(type) ? FromUnion(mapping, type.anyOf) :
                type);
}
