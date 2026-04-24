// deno-fmt-ignore-file
import { Iterator, IsIterator } from '../types/iterator.mjs';
import { ExtendsRight } from './extends-right.mjs';
import { ExtendsLeft } from './extends-left.mjs';
export function ExtendsIterator(inferred, left, right) {
    return (IsIterator(right)
        ? ExtendsLeft(inferred, left, right.iteratorItems)
        : ExtendsRight(inferred, Iterator(left), right));
}
