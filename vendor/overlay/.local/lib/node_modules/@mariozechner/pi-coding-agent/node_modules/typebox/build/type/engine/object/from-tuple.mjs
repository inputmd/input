// deno-fmt-ignore-file
import { Tuple } from '../../types/tuple.mjs';
import { TupleToObject } from '../tuple/to-object.mjs';
import { FromType } from './from-type.mjs';
export function FromTuple(types) {
    const object = TupleToObject(Tuple(types));
    const result = FromType(object);
    return result;
}
