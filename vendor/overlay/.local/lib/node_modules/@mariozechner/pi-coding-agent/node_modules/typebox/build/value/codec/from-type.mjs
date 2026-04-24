// deno-fmt-ignore-file
import * as Type from '../../type/index.mjs';
import { FromArray } from './from-array.mjs';
import { FromCyclic } from './from-cyclic.mjs';
import { FromIntersect } from './from-intersect.mjs';
import { FromObject } from './from-object.mjs';
import { FromRecord } from './from-record.mjs';
import { FromRef } from './from-ref.mjs';
import { FromTuple } from './from-tuple.mjs';
import { FromUnion } from './from-union.mjs';
import { Callback } from './callback.mjs';
export function FromType(direction, context, type, value) {
    return (Type.IsArray(type) ? FromArray(direction, context, type, value) :
        Type.IsCyclic(type) ? FromCyclic(direction, context, type, value) :
            Type.IsIntersect(type) ? FromIntersect(direction, context, type, value) :
                Type.IsObject(type) ? FromObject(direction, context, type, value) :
                    Type.IsRecord(type) ? FromRecord(direction, context, type, value) :
                        Type.IsRef(type) ? FromRef(direction, context, type, value) :
                            Type.IsTuple(type) ? FromTuple(direction, context, type, value) :
                                Type.IsUnion(type) ? FromUnion(direction, context, type, value) :
                                    Callback(direction, context, type, value));
}
