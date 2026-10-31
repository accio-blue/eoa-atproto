// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/pds/repo-write.qnt
// Spec hash (sha256): f9faa26eb04f9c6fbd391e41925e9489f263ce05bf569ccaa00e111835ab163c
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PdsRepoWriteFields = {
    phase: Schema.String,
    commit: Schema.BigInt,
    record: Schema.BigInt,
    staged: Schema.BigInt,
    mstDirty: Schema.Boolean
};
export const PdsRepoWriteStates = Machine.state({
    fields: PdsRepoWriteFields
});
export const PdsRepoWriteEvents = Machine.events({
    init: {},
    submit: {
        seen: Schema.BigInt
    },
    commitWrite: {},
    reload: {}
});
export const PdsRepoWriteDefinition = Machine.make({
    id: "PdsRepoWrite",
    root: PdsRepoWriteStates,
    events: PdsRepoWriteEvents
});
export type PdsRepoWriteEvent = Machine.EventOf<typeof PdsRepoWriteEvents>;
