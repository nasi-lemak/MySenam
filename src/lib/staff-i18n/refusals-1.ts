// Refusals the server sends in English (route handlers and lib/*), in Malay and
// Chinese, keyed by the English sentence exactly as sent. In a pattern, {0},
// {1}… stand for the values the server filled in, in order; the translation
// uses the same numbers. Read by `t.err` (index.ts).

export const REFUSALS: Record<string, { ms: string; zh: string }> = {};
