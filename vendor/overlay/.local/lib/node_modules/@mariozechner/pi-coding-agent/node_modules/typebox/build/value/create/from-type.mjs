// deno-fmt-ignore-file
import * as T from '../../type/index.mjs';
import * as S from '../../schema/types/index.mjs';
import { FromDefault } from './from-default.mjs';
import { FromArray } from './from-array.mjs';
import { FromAsyncIterator } from './from-async-iterator.mjs';
import { FromBase } from './from-base.mjs';
import { FromBigInt } from './from-bigint.mjs';
import { FromBoolean } from './from-boolean.mjs';
import { FromConstructor } from './from-constructor.mjs';
import { FromCyclic } from './from-cyclic.mjs';
import { FromEnum } from './from-enum.mjs';
import { FromFunction } from './from-function.mjs';
import { FromInteger } from './from-integer.mjs';
import { FromIntersect } from './from-intersect.mjs';
import { FromIterator } from './from-iterator.mjs';
import { FromLiteral } from './from-literal.mjs';
import { FromNever } from './from-never.mjs';
import { FromNull } from './from-null.mjs';
import { FromNumber } from './from-number.mjs';
import { FromObject } from './from-object.mjs';
import { FromPromise } from './from-promise.mjs';
import { FromRecord } from './from-record.mjs';
import { FromRef } from './from-ref.mjs';
import { FromString } from './from-string.mjs';
import { FromSymbol } from './from-symbol.mjs';
import { FromTemplateLiteral } from './from-template-literal.mjs';
import { FromTuple } from './from-tuple.mjs';
import { FromUndefined } from './from-undefined.mjs';
import { FromUnion } from './from-union.mjs';
import { FromVoid } from './from-void.mjs';
export function FromType(context, type) {
    return (
    // -----------------------------------------------------
    // Default
    // -----------------------------------------------------
    S.IsDefault(type) ? FromDefault(context, type) :
        // -----------------------------------------------------
        // Types
        // -----------------------------------------------------
        T.IsArray(type) ? FromArray(context, type) :
            T.IsAsyncIterator(type) ? FromAsyncIterator(context, type) :
                T.IsBase(type) ? FromBase(context, type) :
                    T.IsBigInt(type) ? FromBigInt(context, type) :
                        T.IsBoolean(type) ? FromBoolean(context, type) :
                            T.IsConstructor(type) ? FromConstructor(context, type) :
                                T.IsCyclic(type) ? FromCyclic(context, type) :
                                    T.IsEnum(type) ? FromEnum(context, type) :
                                        T.IsFunction(type) ? FromFunction(context, type) :
                                            T.IsInteger(type) ? FromInteger(context, type) :
                                                T.IsIntersect(type) ? FromIntersect(context, type) :
                                                    T.IsIterator(type) ? FromIterator(context, type) :
                                                        T.IsLiteral(type) ? FromLiteral(context, type) :
                                                            T.IsNever(type) ? FromNever(context, type) :
                                                                T.IsNull(type) ? FromNull(context, type) :
                                                                    T.IsNumber(type) ? FromNumber(context, type) :
                                                                        T.IsObject(type) ? FromObject(context, type) :
                                                                            T.IsPromise(type) ? FromPromise(context, type) :
                                                                                T.IsRecord(type) ? FromRecord(context, type) :
                                                                                    T.IsRef(type) ? FromRef(context, type) :
                                                                                        T.IsString(type) ? FromString(context, type) :
                                                                                            T.IsSymbol(type) ? FromSymbol(context, type) :
                                                                                                T.IsTemplateLiteral(type) ? FromTemplateLiteral(context, type) :
                                                                                                    T.IsTuple(type) ? FromTuple(context, type) :
                                                                                                        T.IsUndefined(type) ? FromUndefined(context, type) :
                                                                                                            T.IsUnion(type) ? FromUnion(context, type) :
                                                                                                                T.IsVoid(type) ? FromVoid(context, type) :
                                                                                                                    undefined);
}
