import { Effect, Predicate, Result, Schema } from 'effect';
import type { LexiconDef, Lexicons } from './lexicon.js';
import { BlobSchema } from './schema.js';
import { NSID_PATTERN } from './nsid.js';
import { XRPCInvalidResponseError } from '@eoa/core';
import { stringifyJson } from './json.js';

// Validation result type
export type ValidationResult<A> = Result.Result<A, XRPCInvalidResponseError>;

/** The atproto string formats, and the `cid`/`$link`/`bytes` shapes. */
const CID_PATTERN = /^b[a-z2-7]{58,}$/;

const FORMAT_PATTERNS = new Map<string, RegExp>([
  [
    'at-identifier',
    /^(?:did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)$/,
  ],
  [
    'at-uri',
    /^at:\/\/[a-zA-Z0-9._:%-]+(\/[a-zA-Z0-9._-]+)*(\/[a-zA-Z0-9._-]+)?(#[a-zA-Z0-9._-]+)?$/,
  ],
  ['cid', CID_PATTERN],
  [
    'datetime',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  ],
  ['did', /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/],
  [
    'handle',
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
  ],
  ['language', /^[a-z]{2,3}(-[A-Z]{2})?$/],
  ['nsid', NSID_PATTERN],
  ['record-key', /^[a-zA-Z0-9._:~-]{1,512}$/],
  ['tid', /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/],
  ['uri', /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/],
]);
const BYTES_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// Schema cache for performance. A def with `ref`s resolves through a registry,
// so those schemas belong to that registry: one cache for defs without refs,
// one (weak) cache per registry.
const standaloneCache = new Map<string, Schema.ConstraintDecoder<unknown>>();
const registryCaches = new WeakMap<
  Lexicons,
  Map<string, Schema.ConstraintDecoder<unknown>>
>();

const cacheFor = (
  lexicons: Lexicons | undefined,
): Map<string, Schema.ConstraintDecoder<unknown>> => {
  if (lexicons === undefined) {
    return standaloneCache;
  }
  const cached = registryCaches.get(lexicons);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, Schema.ConstraintDecoder<unknown>>();
  registryCaches.set(lexicons, created);
  return created;
};

const isJsonObject = (
  value: Schema.Json | undefined,
): value is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(value);

const isDef = (value: Schema.Json | undefined): value is LexiconDef =>
  isJsonObject(value) && typeof value['type'] === 'string';

const stringsOf = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];

const numberOf = (value: Schema.Json | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined;

/** `did:plc:abc` (or `did:web:host`) + `#main` → that def, when the doc is known. */
const resolveRef = (params: {
  readonly ref: string;
  readonly lexicons: Lexicons | undefined;
}): Schema.ConstraintDecoder<unknown> => {
  const { ref, lexicons } = params;
  if (lexicons === undefined) {
    return Schema.Unknown;
  }
  const hash = ref.indexOf('#');
  const nsid = hash === -1 ? ref : ref.slice(0, hash);
  const name = hash === -1 ? 'main' : ref.slice(hash + 1);
  const def = lexicons.get(nsid)?.defs[name];
  return def === undefined
    ? Schema.Unknown
    : lexiconToSchema({ lexicon: def, lexicons });
};

const stringSchema = (def: LexiconDef): Schema.ConstraintDecoder<unknown> => {
  const format = def['format'];
  const pattern =
    typeof format === 'string' ? FORMAT_PATTERNS.get(format) : undefined;
  const filters = [
    ...(pattern === undefined ? [] : [Schema.isPattern(pattern)]),
    ...(numberOf(def['minLength']) === undefined
      ? []
      : [Schema.isMinLength(numberOf(def['minLength'])!)]),
    ...(numberOf(def['maxLength']) === undefined
      ? []
      : [Schema.isMaxLength(numberOf(def['maxLength'])!)]),
  ];
  const [first, ...rest] = filters;
  return first === undefined
    ? Schema.String
    : Schema.String.check(first, ...rest);
};

const integerSchema = (def: LexiconDef): Schema.ConstraintDecoder<unknown> => {
  const minimum = numberOf(def['minimum']);
  const maximum = numberOf(def['maximum']);
  const filters = [
    Schema.isInt(),
    ...(minimum === undefined ? [] : [Schema.isGreaterThanOrEqualTo(minimum)]),
    ...(maximum === undefined ? [] : [Schema.isLessThanOrEqualTo(maximum)]),
  ];
  const [first, ...rest] = filters;
  return Schema.Number.check(first!, ...rest);
};

const arraySchema = (params: {
  readonly def: LexiconDef;
  readonly lexicons: Lexicons | undefined;
}): Schema.ConstraintDecoder<unknown> => {
  const { def, lexicons } = params;
  const items = def['items'];
  const element = isDef(items)
    ? lexiconToSchema({ lexicon: items, lexicons })
    : Schema.Unknown;
  const minLength = numberOf(def['minLength']);
  const maxLength = numberOf(def['maxLength']);
  const filters = [
    ...(minLength === undefined ? [] : [Schema.isMinLength(minLength)]),
    ...(maxLength === undefined ? [] : [Schema.isMaxLength(maxLength)]),
  ];
  const array = Schema.Array(element);
  const [first, ...rest] = filters;
  return first === undefined ? array : array.check(first, ...rest);
};

/**
 * An object def. Properties are checked; `required` decides which are optional.
 * atproto objects are open unless `closed: true`, so the rest is preserved — a
 * `$type` and any field the def does not declare survive decoding.
 */
const objectSchema = (params: {
  readonly def: LexiconDef;
  readonly lexicons: Lexicons | undefined;
}): Schema.ConstraintDecoder<unknown> => {
  const { def, lexicons } = params;
  const required = new Set(stringsOf(def['required']));
  const properties = def['properties'];
  const fields: Record<string, Schema.ConstraintDecoder<unknown>> = {};
  if (isJsonObject(properties)) {
    for (const [name, property] of Object.entries(properties)) {
      if (!isDef(property)) {
        continue;
      }
      const field = lexiconToSchema({ lexicon: property, lexicons });
      fields[name] = required.has(name) ? field : Schema.optionalKey(field);
    }
  }
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
};

const unionSchema = (params: {
  readonly def: LexiconDef;
  readonly lexicons: Lexicons | undefined;
}): Schema.ConstraintDecoder<unknown> => {
  const { def, lexicons } = params;
  const refs = stringsOf(def['refs']);
  if (refs.length === 0) {
    return Schema.Unknown;
  }
  return Schema.Union(
    refs.map((ref) => Schema.suspend(() => resolveRef({ ref, lexicons }))),
  );
};

/** Convert a lexicon type definition to an Effect Schema. */
const convert = (params: {
  readonly lexicon: LexiconDef;
  readonly lexicons: Lexicons | undefined;
}): Schema.ConstraintDecoder<unknown> => {
  const { lexicon, lexicons } = params;
  switch (lexicon.type) {
    case 'string':
      return stringSchema(lexicon);

    case 'integer':
      return integerSchema(lexicon);

    case 'boolean':
      return Schema.Boolean;

    case 'null':
      return Schema.Null;

    case 'bytes':
      return Schema.String.check(Schema.isPattern(BYTES_PATTERN));

    case 'cid-link':
      return Schema.Struct({
        $link: Schema.String.check(Schema.isPattern(CID_PATTERN)),
      });

    case 'blob':
      return BlobSchema;

    case 'array':
      return arraySchema({ def: lexicon, lexicons });

    case 'object':
      return objectSchema({ def: lexicon, lexicons });

    case 'record': {
      const record = lexicon['record'];
      return isDef(record)
        ? lexiconToSchema({ lexicon: record, lexicons })
        : Schema.Unknown;
    }

    case 'ref': {
      const ref = lexicon['ref'];
      return typeof ref === 'string'
        ? Schema.suspend(() => resolveRef({ ref, lexicons }))
        : Schema.Unknown;
    }

    case 'union':
      return unionSchema({ def: lexicon, lexicons });

    // `token`, `query`, `procedure`, `subscription`, `permission-set` and
    // `permission` describe methods or markers, not values.
    default:
      return Schema.Unknown;
  }
};

export const lexiconToSchema = (params: {
  readonly lexicon: LexiconDef;
  readonly lexicons?: Lexicons | undefined;
}): Schema.ConstraintDecoder<unknown> => {
  const { lexicon, lexicons } = params;
  const cache = cacheFor(lexicons);
  const cacheKey = stringifyJson(lexicon);
  const cached = cache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const schema = convert({ lexicon, lexicons });
  cache.set(cacheKey, schema);
  return schema;
};

export interface ValidateWithLexiconParams {
  readonly data: Schema.Json;
  readonly lexicon: LexiconDef;
  /** Resolves `ref`s. Without it a `ref` decodes as Unknown. */
  readonly lexicons?: Lexicons | undefined;
}

// Validate data against a lexicon schema. The schema is derived from the def,
// so the decoded value is `unknown` — callers narrow it themselves.
export const validateWithLexicon = ({
  data,
  lexicon,
  lexicons,
}: ValidateWithLexiconParams): Effect.Effect<
  unknown,
  XRPCInvalidResponseError
> => {
  const schema = lexiconToSchema({ lexicon, lexicons });

  return Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(schema)(data);
  }).pipe(
    Effect.catchTag('SchemaError', (error) => {
      const validationErrors = [error.message];
      return Effect.fail(
        new XRPCInvalidResponseError({
          status: 400,
          message: 'Request validation failed',
          validationErrors,
        }),
      );
    }),
  );
};

const schemaOf = (body: Schema.Json | undefined): Schema.Json | undefined =>
  isJsonObject(body) ? body['schema'] : undefined;

// Generic validation helper to reduce code duplication
const validateWithMethod = ({
  value,
  lexicons,
  nsid,
  method,
  getSchemaDef,
}: {
  readonly value: Schema.Json;
  readonly lexicons: Lexicons;
  readonly nsid: string;
  readonly method: string;
  readonly getSchemaDef: (def: LexiconDef) => Schema.Json | undefined;
}): Effect.Effect<unknown, XRPCInvalidResponseError> => {
  const lexicon = lexicons.get(nsid);
  if (!lexicon) {
    return Effect.fail(
      new XRPCInvalidResponseError({
        status: 400,
        message: `Unknown lexicon: ${nsid}`,
        validationErrors: [`No lexicon found for ${nsid}`],
      }),
    );
  }

  const def = lexicon.defs[method];
  if (!def) {
    return Effect.fail(
      new XRPCInvalidResponseError({
        status: 400,
        message: `Unknown method: ${method}`,
        validationErrors: [`No method ${method} in lexicon ${nsid}`],
      }),
    );
  }

  const schemaDef = getSchemaDef(def);
  if (!isDef(schemaDef)) {
    return Effect.succeed(value);
  }

  return validateWithLexicon({ data: value, lexicon: schemaDef, lexicons });
};

export interface AssertValidXrpcParamsArgs {
  readonly params: Schema.Json;
  readonly lexicons: Lexicons;
  readonly nsid: string;
  readonly method?: string;
}

// Validate XRPC parameters
export const assertValidXrpcParams = ({
  params,
  lexicons,
  nsid,
  method = 'main',
}: AssertValidXrpcParamsArgs): Effect.Effect<
  unknown,
  XRPCInvalidResponseError
> => {
  return validateWithMethod({
    value: params,
    lexicons,
    nsid,
    method,
    getSchemaDef: (def) => def.parameters,
  });
};

export interface AssertValidXrpcInputArgs {
  readonly input: Schema.Json;
  readonly lexicons: Lexicons;
  readonly nsid: string;
  readonly method?: string;
}

// Validate XRPC input
export const assertValidXrpcInput = ({
  input,
  lexicons,
  nsid,
  method = 'main',
}: AssertValidXrpcInputArgs): Effect.Effect<
  unknown,
  XRPCInvalidResponseError
> => {
  return validateWithMethod({
    value: input,
    lexicons,
    nsid,
    method,
    getSchemaDef: (def) => schemaOf(def.input),
  });
};

export interface AssertValidXrpcOutputArgs {
  readonly output: Schema.Json;
  readonly lexicons: Lexicons;
  readonly nsid: string;
  readonly method?: string;
}

// Validate XRPC output
export const assertValidXrpcOutput = ({
  output,
  lexicons,
  nsid,
  method = 'main',
}: AssertValidXrpcOutputArgs): Effect.Effect<
  unknown,
  XRPCInvalidResponseError
> => {
  return validateWithMethod({
    value: output,
    lexicons,
    nsid,
    method,
    getSchemaDef: (def) => schemaOf(def.output),
  });
};
