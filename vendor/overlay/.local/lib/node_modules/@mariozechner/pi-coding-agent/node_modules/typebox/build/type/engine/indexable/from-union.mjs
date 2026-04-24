// deno-fmt-ignore-file
import { FromType } from './from-type.mjs';
export function FromUnion(types) {
    return types.reduce((result, left) => {
        return [...result, ...FromType(left)];
    }, []);
}
