// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/space-host/space-write-log.qnt
// Spec hash (sha256): 0286d9fa5f1069aa95365a7da3ba5fabf05be7017b240226813ea2e9ced96bbe
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const SpaceWriteLogFields = {
    logHead: Schema.BigInt,
    base: Schema.BigInt,
    outcome: Schema.String
};
export const SpaceWriteLogStates = Machine.state({
    fields: SpaceWriteLogFields
});
export const SpaceWriteLogEvents = Machine.events({
    init: {},
    begin: {},
    appendOp: {},
    race: {
        delta: Schema.BigInt
    }
});
export const SpaceWriteLogDefinition = Machine.make({
    id: "SpaceWriteLog",
    root: SpaceWriteLogStates,
    events: SpaceWriteLogEvents
});
export type SpaceWriteLogEvent = Machine.EventOf<typeof SpaceWriteLogEvents>;
