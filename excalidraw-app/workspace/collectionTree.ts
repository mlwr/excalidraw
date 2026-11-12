/**
 * Intranet fork: collections inside collections (W4). The server lists the
 * collections a person sees, each with its parent if that one is visible,
 * too; these helpers turn the list into a tree.
 */
import type { CollectionInfo } from "../intranet/workspaceApi";

/** the visible collections from the top down to this one */
export const collectionPath = (
  collections: readonly CollectionInfo[],
  id: string,
): CollectionInfo[] => {
  const byId = new Map(collections.map((item) => [item.id, item]));
  const path: CollectionInfo[] = [];
  let current = byId.get(id);
  for (let depth = 0; current && depth < 16; depth++) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
};

/** "Abteilung › Projekt › Thema" */
export const collectionLabel = (
  collections: readonly CollectionInfo[],
  id: string,
) =>
  collectionPath(collections, id)
    .map((item) => item.name)
    .join(" › ");

export const childrenOf = (
  collections: readonly CollectionInfo[],
  parentId: string | null,
) => collections.filter((item) => (item.parentId ?? null) === parentId);

/** the collection and everything inside it */
export const subtreeIds = (
  collections: readonly CollectionInfo[],
  id: string,
): Set<string> => {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of collections) {
      if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        grew = true;
      }
    }
  }
  return ids;
};

/** depth-first, as the sidebar shows them */
export const flattenTree = (
  collections: readonly CollectionInfo[],
  collapsed: ReadonlySet<string> = new Set(),
) => {
  const rows: {
    collection: CollectionInfo;
    depth: number;
    hasChildren: boolean;
  }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const collection of childrenOf(collections, parentId)) {
      const hasChildren = collections.some(
        (item) => item.parentId === collection.id,
      );
      rows.push({ collection, depth, hasChildren });
      if (hasChildren && !collapsed.has(collection.id) && depth < 16) {
        visit(collection.id, depth + 1);
      }
    }
  };
  visit(null, 0);
  return rows;
};
