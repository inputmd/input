// deno-fmt-ignore-file
import { EnumValuesToUnion } from '../enum/enum-to-union.mjs';
import { FromKey } from './from-key.mjs';
export function FromEnumKey(values, value) {
    const unionKey = EnumValuesToUnion(values);
    const result = FromKey(unionKey, value);
    return result;
}
