// Fork (F20): folders in the legacy sidebar. The folder rules shared with the phone app live in
// `@t3tools/client-runtime/thread-folders`; this file keeps the sidebar's row windowing.

export interface GroupPanel<K> {
  /** Rows shown, in list order. */
  readonly rendered: K[];
  /** Rows a "Show more" would add. */
  readonly hidden: K[];
  readonly hasOverflow: boolean;
}

/**
 * Which threads a folder shows. Collapsed, only the open thread stays; open, the first
 * `previewCount` show (all after "Show more"), plus the open thread wherever it sits.
 */
export function resolveGroupPanel<K>(input: {
  readonly keys: readonly K[];
  readonly expanded: boolean;
  readonly showAll: boolean;
  readonly previewCount: number;
  readonly activeKey: K | null;
}): GroupPanel<K> {
  const { keys, expanded, showAll, previewCount, activeKey } = input;
  const activeInGroup = activeKey !== null && keys.includes(activeKey);
  if (!expanded) {
    return { rendered: activeInGroup ? [activeKey] : [], hidden: [], hasOverflow: false };
  }
  // The open thread stays listed past the cut, so it alone does not overflow the preview.
  const hasOverflow = keys.some((key, index) => index >= previewCount && key !== activeKey);
  if (showAll || !hasOverflow) return { rendered: [...keys], hidden: [], hasOverflow };
  const rendered: K[] = [];
  const hidden: K[] = [];
  for (const [index, key] of keys.entries()) {
    if (index < previewCount || key === activeKey) rendered.push(key);
    else hidden.push(key);
  }
  return { rendered, hidden, hasOverflow };
}
