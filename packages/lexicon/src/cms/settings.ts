import { Schema } from 'effect';

/**
 * The one settings record a site has.
 *
 * It is data, not configuration: the admin edits it, the site's build reads it, and it lives in
 * the account beside the content. What belongs here is anything a *person* would want to change
 * without a deployment — the site's title and address, the locales it speaks, where its preview
 * lives, what the editor offers. What does not belong here is anything a deployment decides:
 * Worker names, domains, tokens. Those stay in the stack.
 *
 * Every field is optional, and an absent field means the code's own default: a settings record
 * written before a field existed must keep working, which is the whole reason not to make any of
 * this required.
 */

export const SETTINGS_NSID = 'ing.lexicon.cms.settings';

/** The rkey of the record: a site has one settings, and it is `default`. */
export const SETTINGS_RKEY = 'default';

const LocaleSchema = Schema.String.check(Schema.isMinLength(2));

export const SettingsSchema = Schema.Struct({
  $type: Schema.optionalKey(Schema.Literal(SETTINGS_NSID)),
  /** What the site calls itself, and where it is. */
  site: Schema.optionalKey(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
  /** The languages of the content, and how a reader without one is answered. */
  locales: Schema.optionalKey(
    Schema.Struct({
      default: Schema.optionalKey(LocaleSchema),
      supported: Schema.optionalKey(Schema.Array(LocaleSchema)),
      /** The locale a missing translation falls back to; the default locale by default. */
      fallback: Schema.optionalKey(LocaleSchema),
    }),
  ),
  /** What the editor offers: how much of a list, where a preview points, which types matter. */
  editor: Schema.optionalKey(
    Schema.Struct({
      pageSize: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      /** The site a preview opens: stage, usually, so a draft is not published to see it. */
      previewUrl: Schema.optionalKey(Schema.String),
      /** The types the document list leads with, in order. Absent means every type. */
      types: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /** How it looks. Only what an interface actually reads: no colours nobody uses. */
  branding: Schema.optionalKey(
    Schema.Struct({
      accent: Schema.optionalKey(Schema.String),
      logoUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Which catalog namespaces the clients must have, and whether a gap fails the build. */
  i18n: Schema.optionalKey(
    Schema.Struct({
      namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
      requireComplete: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
});
export type Settings = typeof SettingsSchema.Type;

/** What a reader gets when the record says nothing: the deployment's own defaults. */
export interface SettingsDefaults {
  readonly title: string;
  readonly url: string;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly fallbackLocale: string;
  readonly pageSize: number;
  readonly previewUrl: string | undefined;
  readonly types: readonly string[] | undefined;
}

interface SettingsWithDefaultsInput {
  readonly settings: Settings | undefined;
  readonly defaults: SettingsDefaults;
}

const siteValues = ({ settings, defaults }: SettingsWithDefaultsInput) => ({
  title: settings?.site?.title ?? defaults.title,
  url: settings?.site?.url ?? defaults.url,
});

const localeValues = ({ settings, defaults }: SettingsWithDefaultsInput) => ({
  defaultLocale: settings?.locales?.default ?? defaults.defaultLocale,
  supportedLocales: settings?.locales?.supported ?? defaults.supportedLocales,
  fallbackLocale:
    settings?.locales?.fallback ??
    settings?.locales?.default ??
    defaults.fallbackLocale,
});

const editorValues = ({ settings, defaults }: SettingsWithDefaultsInput) => ({
  pageSize: settings?.editor?.pageSize ?? defaults.pageSize,
  previewUrl: settings?.editor?.previewUrl ?? defaults.previewUrl,
  types: settings?.editor?.types ?? defaults.types,
});

/**
 * The record, read as the values a client uses: absent fields filled from the defaults this
 * caller owns, because a default belongs to the deployment and the record only overrides it.
 */
export const settingsWithDefaults = (input: SettingsWithDefaultsInput) => ({
  ...siteValues(input),
  ...localeValues(input),
  ...editorValues(input),
});
