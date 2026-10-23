'use client';
import { memo, useSyncExternalStore } from 'react';
import { useDrawer } from './DrawerProvider';

// Table row that opens the shared drawer for one item. It subscribes only to "am I the open item?", so opening the
// drawer or stepping Previous/Next re-renders two rows, not the whole table.
export const OpenRow = memo(function OpenRow({ kind, id, children }) {
  const { open, selection } = useDrawer();
  const key = `${kind}:${id}`;
  const selected = useSyncExternalStore(selection.subscribe, () => selection.get() === key, () => false);
  return (
    <tr
      tabIndex={0}
      className={selected ? 'selected' : undefined}
      onClick={() => open(kind, id)}
      onKeyDown={(e) => { if (e.key === 'Enter') open(kind, id); }}
    >
      {children}
    </tr>
  );
});
