// deno-fmt-ignore-file
import { Promise, IsPromise } from '../types/promise.mjs';
import { ExtendsRight } from './extends-right.mjs';
import { ExtendsLeft } from './extends-left.mjs';
export function ExtendsPromise(inferred, left, right) {
    return (IsPromise(right)
        ? ExtendsLeft(inferred, left, right.item)
        : ExtendsRight(inferred, Promise(left), right));
}
