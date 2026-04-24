// deno-fmt-ignore-file
// deno-lint-ignore-file
import { IsAny } from '../../types/any.mjs';
import { IsBoolean } from '../../types/boolean.mjs';
import { IsEnum } from '../../types/enum.mjs';
import { IsIntersect } from '../../types/intersect.mjs';
import { IsInteger } from '../../types/integer.mjs';
import { IsLiteral } from '../../types/literal.mjs';
import { IsNumber } from '../../types/number.mjs';
import { Object } from '../../types/object.mjs';
import { IsString } from '../../types/string.mjs';
import { IsTemplateLiteral } from '../../types/template-literal.mjs';
import { IsUnion } from '../../types/union.mjs';
// ------------------------------------------------------------------
// Keys and Deferred
// ------------------------------------------------------------------
import { FromAnyKey } from './from-key-any.mjs';
import { FromBooleanKey } from './from-key-boolean.mjs';
import { FromEnumKey } from './from-key-enum.mjs';
import { FromIntegerKey } from './from-key-integer.mjs';
import { FromIntersectKey } from './from-key-intersect.mjs';
import { FromLiteralKey } from './from-key-literal.mjs';
import { FromNumberKey } from './from-key-number.mjs';
import { FromStringKey } from './from-key-string.mjs';
import { FromTemplateKey } from './from-key-template-literal.mjs';
import { FromUnionKey } from './from-key-union.mjs';
export function FromKey(key, value) {
    const result = (IsAny(key) ? FromAnyKey(value) :
        IsBoolean(key) ? FromBooleanKey(value) :
            IsEnum(key) ? FromEnumKey(key.enum, value) :
                IsInteger(key) ? FromIntegerKey(key, value) :
                    IsIntersect(key) ? FromIntersectKey(key.allOf, value) :
                        IsLiteral(key) ? FromLiteralKey(key.const, value) :
                            IsNumber(key) ? FromNumberKey(key, value) :
                                IsUnion(key) ? FromUnionKey(key.anyOf, value) :
                                    IsString(key) ? FromStringKey(key, value) :
                                        IsTemplateLiteral(key) ? FromTemplateKey(key.pattern, value) :
                                            Object({}));
    return result;
}
