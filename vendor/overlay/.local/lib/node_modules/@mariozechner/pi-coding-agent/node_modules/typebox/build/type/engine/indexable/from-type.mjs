// deno-fmt-ignore-file
import { IsCyclic } from '../../types/cyclic.mjs';
import { IsEnum } from '../../types/enum.mjs';
import { IsIntersect } from '../../types/intersect.mjs';
import { IsLiteral } from '../../types/literal.mjs';
import { IsTemplateLiteral } from '../../types/template-literal.mjs';
import { IsUnion } from '../../types/union.mjs';
import { FromCyclic } from './from-cyclic.mjs';
import { FromEnum } from './from-enum.mjs';
import { FromIntersect } from './from-intersect.mjs';
import { FromLiteral } from './from-literal.mjs';
import { FromTemplateLiteral } from './from-template-literal.mjs';
import { FromUnion } from './from-union.mjs';
export function FromType(type) {
    return (IsCyclic(type) ? FromCyclic(type.$defs, type.$ref) :
        IsEnum(type) ? FromEnum(type.enum) :
            IsIntersect(type) ? FromIntersect(type.allOf) :
                IsLiteral(type) ? FromLiteral(type.const) :
                    IsTemplateLiteral(type) ? FromTemplateLiteral(type.pattern) :
                        IsUnion(type) ? FromUnion(type.anyOf) :
                            []);
}
