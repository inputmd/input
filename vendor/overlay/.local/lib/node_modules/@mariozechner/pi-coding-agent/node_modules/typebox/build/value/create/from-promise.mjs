// deno-fmt-ignore-file
import { FromType } from './from-type.mjs';
export function FromPromise(context, type) {
    return Promise.resolve(FromType(context, type.item));
}
