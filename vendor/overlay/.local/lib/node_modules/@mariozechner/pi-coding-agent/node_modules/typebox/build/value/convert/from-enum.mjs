// deno-fmt-ignore-file
import { EnumToUnion } from '../../type/engine/enum/index.mjs';
import { FromUnion } from './from-union.mjs';
export function FromEnum(context, type, value) {
    const union = EnumToUnion(type);
    return FromUnion(context, union, value);
}
