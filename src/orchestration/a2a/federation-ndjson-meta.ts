/** P32: shared empty-filter NDJSON meta line for prune-log and lease audit exports. */

export const FEDERATION_LOG_EMPTY_NDJSON_SCHEMA = "federation-log-empty-v1" as const;

export type FederationLogNdjsonEmptyMetaInput = {
  version: number;
  updatedAt: string;
  totalCount: number;
  truncated: boolean;
  emptyHint: string;
  emptyHintCode: string;
  receiptNotFound?: boolean;
};

export function federationLogNdjsonEmptyMetaObject(
  input: FederationLogNdjsonEmptyMetaInput,
): Record<string, unknown> {
  return {
    _meta: true,
    schema: FEDERATION_LOG_EMPTY_NDJSON_SCHEMA,
    version: input.version,
    updatedAt: input.updatedAt,
    totalCount: input.totalCount,
    truncated: input.truncated,
    filteredEmpty: true,
    emptyHint: input.emptyHint,
    emptyHintCode: input.emptyHintCode,
    ...(input.receiptNotFound ? { receiptNotFound: true } : {}),
  };
}

export function stringifyFederationLogNdjsonEmptyMeta(
  input: FederationLogNdjsonEmptyMetaInput,
): string {
  return JSON.stringify(federationLogNdjsonEmptyMetaObject(input));
}
