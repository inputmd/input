// deno-fmt-ignore-file
import { IsVoid } from '../types/void.mjs';
import { ExtendsLeft } from './extends-left.mjs';
import * as Result from './result.mjs';
export function ExtendsReturnType(inferred, left, right) {
    return (IsVoid(right)
        ? Result.ExtendsTrue(inferred)
        : ExtendsLeft(inferred, left, right));
}
