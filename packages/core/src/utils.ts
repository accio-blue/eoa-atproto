import { HeadersMap, QueryParams } from './types.js';

// URL building utilities
export const buildURL = (
  base: string,
  path: string,
  params?: QueryParams,
): string => {
  const url = new URL(path, base);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
};

// Header utilities
export const mergeHeaders = (
  ...headers: (Record<string, string> | undefined)[]
): HeadersMap => {
  const result: HeadersMap = {};

  for (const header of headers) {
    if (header) {
      Object.assign(result, header);
    }
  }

  return result;
};
