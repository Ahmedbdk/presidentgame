export function advanceTableActionRevision(revisionRef) {
  revisionRef.current += 1;
  return revisionRef.current;
}

export function isCurrentTableActionRevision(revisionRef, revision) {
  return revisionRef.current === revision;
}
