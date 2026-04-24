// deno-fmt-ignore-file
import { Memory } from '../../system/memory/index.mjs';
import { IsKind } from './schema.mjs';
import { IsTypeScriptEnumLike } from '../engine/enum/typescript-enum-to-enum-values.mjs';
import { TypeScriptEnumToEnumValues } from '../engine/enum/typescript-enum-to-enum-values.mjs';
/** Creates an Enum type. */
export function Enum(value, options) {
    const values = IsTypeScriptEnumLike(value) ? TypeScriptEnumToEnumValues(value) : value;
    return Memory.Create({ '~kind': 'Enum' }, { enum: values }, options);
}
// ------------------------------------------------------------------
// Guard
// ------------------------------------------------------------------
/** Returns true if the given value is a TEnum. */
export function IsEnum(value) {
    return IsKind(value, 'Enum');
}
