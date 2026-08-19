// The in-session claim mutex (CONTEXT.md: Claim) — the fast, in-process guard
// that complements the provider's authoritative, cross-process `claim`. The
// provider's atomic write is the real mutex (two processes cannot both flip
// `Status: claimed`); this registry adds the cheap in-session short-circuit so
// a double-`Enter` in one process never reaches the filesystem lock, and tracks
// the herdr tab each dispatched issue landed in. Each entry records:
//  - `confirmed`: the tracker has shown `claimed` (the dispatch's claim has been
//    observed on reload). After that, a return to `open` is a reset →
//    re-dispatchable; until then, an `open` status is the pre-reload window.
//  - `tabId` + `paneId`: which herdr tab/pane hosts the agent — `tabId` drives
//    `releaseIssue`'s tab close, `paneId` drives dead-dispatch reconciliation.
//  - `dispatchedAt`: when we dispatched — the grace clock for the dead-dispatch
//    check (release a dispatch whose tab closed before its claim was observed).

export class ClaimRegistry {
  private readonly claimed = new Map<
    string,
    { confirmed: boolean; tabId?: string; paneId?: string; dispatchedAt: number }
  >();

  /** Claim `id` for this session; false when it is already claimed. */
  tryClaim(id: string): boolean {
    if (this.claimed.has(id)) return false;
    this.claimed.set(id, { confirmed: false, dispatchedAt: Date.now() });
    return true;
  }

  /** Record the herdr tab the agent landed in (after `tab create`). */
  setTabId(id: string, tabId: string): void {
    const entry = this.claimed.get(id);
    if (entry) entry.tabId = tabId;
  }

  /** Record the herdr pane the agent landed in (after `tab create`). */
  setPaneId(id: string, paneId: string): void {
    const entry = this.claimed.get(id);
    if (entry) entry.paneId = paneId;
  }

  /** Free `id` so a later dispatch can retry. */
  release(id: string): void {
    this.claimed.delete(id);
  }

  /** Record that the tracker shows `claimed` for `id` (the dispatch's claim has
   *  been observed on reload). After this, a return to `open` is a reset, not
   *  the pre-reload window. */
  confirm(id: string): void {
    const entry = this.claimed.get(id);
    if (entry) entry.confirmed = true;
  }

  has(id: string): boolean {
    return this.claimed.has(id);
  }

  isConfirmed(id: string): boolean {
    return this.claimed.get(id)?.confirmed ?? false;
  }

  paneIdOf(id: string): string | undefined {
    return this.claimed.get(id)?.paneId;
  }

  tabIdOf(id: string): string | undefined {
    return this.claimed.get(id)?.tabId;
  }

  dispatchedAtOf(id: string): number | undefined {
    return this.claimed.get(id)?.dispatchedAt;
  }

  /** All ids currently held by the mutex (for reconcile). */
  ids(): string[] {
    return [...this.claimed.keys()];
  }
}