// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/pds/account-move.qnt
// Spec hash (sha256): 18f07cf9a3221f1171a1d05c946b4c5d6e5a4a296628b4072b23701b68d3145d
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PdsAccountMoveFields = {
    phase: Schema.String,
    advanced: Schema.BigInt,
    spaces: Schema.Boolean,
    discovered: Schema.Boolean
};
export const PdsAccountMoveStates = Machine.state({
    fields: PdsAccountMoveFields
});
export const PdsAccountMoveEvents = Machine.events({
    init: {},
    discover: {
        hasSpaces: Schema.Boolean
    },
    advance: {
        target: Schema.String
    }
});
export const PdsAccountMoveDefinition = Machine.make({
    id: "PdsAccountMove",
    root: PdsAccountMoveStates,
    events: PdsAccountMoveEvents
});
export type PdsAccountMoveEvent = Machine.EventOf<typeof PdsAccountMoveEvents>;
