// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/video/playback-readiness.qnt
// Spec hash (sha256): 0917ef489b7aa9e5b3bf24e00e23ed9db7189d377ba58826005b9e635de389be
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const VideoPlaybackReadinessFields = {
    stage: Schema.String,
    requests: Schema.BigInt,
    served: Schema.BigInt,
    blocked: Schema.BigInt
};
export const VideoPlaybackReadinessStates = Machine.state({
    fields: VideoPlaybackReadinessFields
});
export const VideoPlaybackReadinessEvents = Machine.events({
    init: {},
    publish: {},
    request: {},
    remove: {}
});
export const VideoPlaybackReadinessDefinition = Machine.make({
    id: "VideoPlaybackReadiness",
    root: VideoPlaybackReadinessStates,
    events: VideoPlaybackReadinessEvents
});
export type VideoPlaybackReadinessEvent = Machine.EventOf<typeof VideoPlaybackReadinessEvents>;
