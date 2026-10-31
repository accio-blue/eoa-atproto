// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/plugin-host/plugin_lifecycle.qnt
// Spec hash (sha256): c6ac281c1090ed90c33406b283e11fa4fcf182f0ff70bf6b19945e1e0909b0d3
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PluginLifecycleFields = {
    status: Schema.String,
    manifest: Schema.String,
    gate: Schema.String,
    isolate: Schema.String,
    requested: Schema.String
};
export const PluginLifecycleStates = Machine.state({
    fields: PluginLifecycleFields
});
export const PluginLifecycleEvents = Machine.events({
    init: {},
    install: {},
    activate: {},
    escalate: {
        scope: Schema.String
    },
    approve: {},
    reject: {},
    uninstall: {}
});
export const PluginLifecycleDefinition = Machine.make({
    id: "PluginLifecycle",
    root: PluginLifecycleStates,
    events: PluginLifecycleEvents
});
export type PluginLifecycleEvent = Machine.EventOf<typeof PluginLifecycleEvents>;
