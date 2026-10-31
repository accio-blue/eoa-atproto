import { Schema } from 'effect';

// AT Protocol base types
export type DID = string & Schema.Schema.Type<typeof DID>;
export const DID = Schema.String.check(
  Schema.isPattern(/^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/),
).pipe(Schema.brand('DID'));

export type Handle = string & Schema.Schema.Type<typeof Handle>;
export const Handle = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/),
).pipe(Schema.brand('Handle'));

export type NSID = string & Schema.Schema.Type<typeof NSID>;
export const NSID = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9.-]+$/),
).pipe(Schema.brand('NSID'));

export type ATURI = string & Schema.Schema.Type<typeof ATURI>;
export const ATURI = Schema.String.check(
  Schema.isPattern(
    /^at:\/\/[a-zA-Z0-9._:%-]+(?:\/[a-zA-Z0-9._-]+)*(?:\/[a-zA-Z0-9._-]+)?(?:#[a-zA-Z0-9._-]+)?$/,
  ),
).pipe(Schema.brand('ATURI'));

export type TID = string & Schema.Schema.Type<typeof TID>;
export const TID = Schema.String.check(Schema.isPattern(/^[2-7a-z]{13}$/)).pipe(
  Schema.brand('TID'),
);

// Common request/response types
export interface CallOptions {
  readonly encoding?: string;
  readonly headers?: Record<string, string>;
  readonly timeout?: number;
}

export type QueryParamValue = Schema.Json | undefined;

export interface QueryParams {
  readonly [key: string]: QueryParamValue;
}

export interface HeadersMap {
  readonly [key: string]: string;
}
