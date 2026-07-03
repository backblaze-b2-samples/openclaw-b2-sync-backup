export function isNodeError(err: unknown, code: string): err is Error & { code: string } {
  return err instanceof Error && "code" in err && err.code === code;
}
