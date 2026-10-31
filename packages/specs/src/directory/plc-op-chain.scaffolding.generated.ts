// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/directory/plc-op-chain.qnt
// Spec hash (sha256): 85c4c13436ad0012c90b1beb5471ea8f7143096f2062c9b04a5d6bed5a848666
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PlcOpChainFields = {
    lifecycle: Schema.String,
    did: Schema.String,
    headKind: Schema.String,
    rotationKey: Schema.String,
    signingKey: Schema.String,
    handle: Schema.String,
    pds: Schema.String,
    logLen: Schema.BigInt,
    canonicalLen: Schema.BigInt,
    nullified: Schema.BigInt,
    forkCount: Schema.BigInt
};
export const PlcOpChainStates = Machine.state({
    fields: PlcOpChainFields
});
export const PlcOpChainEvents = Machine.events({
    init: {},
    create: {},
    rotate: {
        newKey: Schema.String
    },
    rebind: {
        target: Schema.String
    },
    nullify: {
        scope: Schema.String
    },
    tombstone: {}
});
export const PlcOpChainDefinition = Machine.make({
    id: "PlcOpChain",
    root: PlcOpChainStates,
    events: PlcOpChainEvents
});
export type PlcOpChainEvent = Machine.EventOf<typeof PlcOpChainEvents>;
