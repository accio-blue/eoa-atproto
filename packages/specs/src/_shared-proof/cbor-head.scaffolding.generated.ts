// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/_shared-proof/cbor-head.qnt
// Spec hash (sha256): 89b6caac62f705ee4f3c258aa1b970dd9883b41158a7b65c2cf9e00eb3268121
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const SharedProofCborHeadFields = {
    lastArg: Schema.BigInt,
    lastClass: Schema.BigInt,
    canonical: Schema.Boolean
};
export const SharedProofCborHeadStates = Machine.state({
    fields: SharedProofCborHeadFields
});
export const SharedProofCborHeadEvents = Machine.events({
    init: {},
    putHead: {
        n: Schema.BigInt
    }
});
export const SharedProofCborHeadDefinition = Machine.make({
    id: "SharedProofCborHead",
    root: SharedProofCborHeadStates,
    events: SharedProofCborHeadEvents
});
export type SharedProofCborHeadEvent = Machine.EventOf<typeof SharedProofCborHeadEvents>;
