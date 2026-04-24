// deno-fmt-ignore-file
import { EnumValuesToVariants } from '../enum/enum-to-union.mjs';
import { FromUnion } from './from-union.mjs';
export function FromEnum(values) {
    const variants = EnumValuesToVariants(values);
    const result = FromUnion(variants);
    return result;
}
