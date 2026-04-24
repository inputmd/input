// deno-fmt-ignore-file
import { FromType } from './from-type.mjs';
export function FromFunction(context, type) {
    const returnType = FromType(context, type.returnType);
    return () => returnType;
}
