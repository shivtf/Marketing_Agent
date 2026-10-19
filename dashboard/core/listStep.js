// Previous / Next in the drawer: the items on either side of the open one. The open item can leave the list while it is
// open (e.g. a reply labelled into another group on Positive Leads): then `last`, where it was, is used, so Previous is
// the item before that spot and Next the item that moved into it. No imports, so `node --test` can load it.
// -> { index, prev, next } (index: where the open item is now, -1 if it left the list)
export function neighbours(items, id, last = -1) {
  const index = items.findIndex((x) => x.id === id);
  const at = index >= 0 ? index : last;
  return {
    index,
    prev: at > 0 ? items[at - 1] : undefined,
    next: index >= 0 ? items[index + 1] : at >= 0 ? items[at] : undefined,
  };
}
