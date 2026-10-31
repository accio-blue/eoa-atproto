// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/video/transcode-job.qnt
// Spec hash (sha256): e3e85446d5070b452d54e5cf2ffe474e544cddd22369a3874466aae27caa6689
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const VideoTranscodeJobFields = {
    stage: Schema.String,
    attempts: Schema.BigInt,
    failures: Schema.BigInt,
    progress: Schema.BigInt,
    playlist: Schema.Boolean
};
export const VideoTranscodeJobStates = Machine.state({
    fields: VideoTranscodeJobFields
});
export const VideoTranscodeJobEvents = Machine.events({
    init: {},
    start: {},
    advance: {
        increment: Schema.BigInt
    },
    finish: {},
    abort: {},
    requeue: {}
});
export const VideoTranscodeJobDefinition = Machine.make({
    id: "VideoTranscodeJob",
    root: VideoTranscodeJobStates,
    events: VideoTranscodeJobEvents
});
export type VideoTranscodeJobEvent = Machine.EventOf<typeof VideoTranscodeJobEvents>;
