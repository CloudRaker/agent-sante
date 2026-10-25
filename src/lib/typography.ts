// French typography: a non-breaking space before : ; ? ! and inside « », so a sign never starts a line.
const BEFORE = / ([:;?!»])/g;
const AFTER = /« /g;

export function frenchSpaces(text: string): string {
  return text.replace(BEFORE, " $1").replace(AFTER, "« ");
}

/** Applies a string transform to every string (and every function result) of a dictionary. */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (typeof value === "function") {
    return ((...args: unknown[]) => mapStrings((value as (...a: unknown[]) => unknown)(...args), fn)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}
