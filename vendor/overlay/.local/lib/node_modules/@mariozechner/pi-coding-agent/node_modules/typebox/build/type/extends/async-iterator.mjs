// deno-fmt-ignore-file
import { AsyncIterator, IsAsyncIterator } from '../types/async-iterator.mjs';
import { ExtendsRight } from './extends-right.mjs';
import { ExtendsLeft } from './extends-left.mjs';
export function ExtendsAsyncIterator(inferred, left, right) {
    return (IsAsyncIterator(right)
        ? ExtendsLeft(inferred, left, right.iteratorItems)
        : ExtendsRight(inferred, AsyncIterator(left), right));
}
