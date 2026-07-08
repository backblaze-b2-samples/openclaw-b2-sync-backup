type ReadJsonFileWithFallback = <T>(
  filePath: string,
  fallback: T,
) => Promise<{ value: T } & Record<string, unknown>>;

type WriteJsonFileAtomically = (filePath: string, value: unknown) => Promise<void>;

type JsonStoreHelpers = {
  readJsonFileWithFallback: ReadJsonFileWithFallback;
  writeJsonFileAtomically: WriteJsonFileAtomically;
};

let helperPromise: Promise<JsonStoreHelpers> | null = null;

export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T } & Record<string, unknown>> {
  const helpers = await loadJsonStoreHelpers();
  return helpers.readJsonFileWithFallback(filePath, fallback);
}

export async function writeJsonFileAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const helpers = await loadJsonStoreHelpers();
  await helpers.writeJsonFileAtomically(filePath, value);
}

async function loadJsonStoreHelpers(): Promise<JsonStoreHelpers> {
  helperPromise ??= resolveJsonStoreHelpers();
  return helperPromise;
}

async function resolveJsonStoreHelpers(): Promise<JsonStoreHelpers> {
  const errors: unknown[] = [];

  for (const specifier of ["openclaw/plugin-sdk/json-store", "openclaw/plugin-sdk"]) {
    try {
      const sdkModule = await import(specifier);
      if (isJsonStoreHelpers(sdkModule)) return sdkModule;
      errors.push(new Error(`${specifier} does not export JSON-store helpers`));
    } catch (err) {
      errors.push(err);
    }
  }

  throw new Error(
    "b2-backup: OpenClaw plugin SDK JSON-store helpers are unavailable. " +
      "Use OpenClaw 2026.4+ or a legacy OpenClaw build that exports them from openclaw/plugin-sdk.",
    { cause: new AggregateError(errors) },
  );
}

function isJsonStoreHelpers(value: unknown): value is JsonStoreHelpers {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<JsonStoreHelpers>;
  return (
    typeof candidate.readJsonFileWithFallback === "function" &&
    typeof candidate.writeJsonFileAtomically === "function"
  );
}
