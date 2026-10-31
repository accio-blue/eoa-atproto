// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/appview/ingestion-pipeline.qnt
// Spec hash (sha256): fbb3221e2eceedd0ce62a59df5863b39e9c82260f99b47fbad6f4b56b78129d5
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const AppviewIngestionPipelineFields = {
    stage: Schema.String,
    cursor: Schema.BigInt,
    buffered: Schema.BigInt,
    applied: Schema.BigInt,
    projected: Schema.BigInt
};
export const AppviewIngestionPipelineStates = Machine.state({
    fields: AppviewIngestionPipelineFields
});
export const AppviewIngestionPipelineEvents = Machine.events({
    init: {},
    start: {},
    receive: {
        delta: Schema.BigInt
    },
    apply: {},
    project: {}
});
export const AppviewIngestionPipelineDefinition = Machine.make({
    id: "AppviewIngestionPipeline",
    root: AppviewIngestionPipelineStates,
    events: AppviewIngestionPipelineEvents
});
export type AppviewIngestionPipelineEvent = Machine.EventOf<typeof AppviewIngestionPipelineEvents>;
