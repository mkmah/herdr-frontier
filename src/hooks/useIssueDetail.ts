// useIssueDetail — the detail pane's state pipeline (architecture review
// 2026-08, layered-frontend layout): the fetched verbose record for the selected
// Issue, its in-flight flag, the keyed-remount key (OpenTUI 0.5.1 doesn't
// repaint in place), and the displayed content record the pane paints. Owns the
// width math both panes budget their rows from (the split differs by view).
// Extracted from App.tsx so the composition root stays a thin wire-up of hooks.

import { createMemo, createEffect, createSignal } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { ShellController } from "#/services/shell/shell.js";
import type { Issue, IssueDetail } from "#/services/tracker/provider.js";
import type { AgentStatus } from "#/services/herdr/types.js";
import type { CategorySummary } from "#/lib/rows.js";
import type { AppView, DetailContentProps, DispatchUi, ReleaseUi } from "#/types.js";

// The scrollbox that carries a pane's rows renders its content 2 columns
// narrower than the pane's border-padding math predicts (measured empirically
// at widths 50/58/60/70/100, in both the list and the tree rows — see the width
// comments below). A row's title budget is floored at 0, but a budget even one
// char too generous wraps the row to a second line, so both panes budget this
// inset. The detail pane is exact at −4 because its scrollbox declares its own
// 1+1 padding (see DetailPane), so only the row-carrying scrollboxes use this.
const ROW_SCROLLBOX_INSET = 6;

export function useIssueDetail(args: {
  shell: ShellController;
  selected: () => Issue | undefined;
  /** The whole-category selection under the list cursor, if any — its summary
   *  paints in place of any issue body (collapsible-categories 01). */
  selectedCategory: () => CategorySummary | null;
  /** Pre-loaded detail for the first selection (test seam); production omits it. */
  initialDetail?: IssueDetail;
  dispatchState: () => DispatchUi;
  releaseState: () => ReleaseUi;
  runVersion: () => number;
  pulse: () => boolean;
  agentStatusOf: (issue: Issue) => AgentStatus | undefined;
  resolvedFor: (issue: Issue) => (id: string) => boolean;
  view: () => AppView;
}) {
  const dims = useTerminalDimensions();
  const [detail, setDetail] = createSignal<IssueDetail | null>(args.initialDetail ?? null);
  const [detailLoading, setDetailLoading] = createSignal(false);

  // Load the selected Issue's full body whenever the selection changes. Each
  // read is guarded by the requested id: a read that resolves after a newer one
  // was requested (fast cursor moves) is discarded so the detail pane can never
  // show a body that doesn't match the selected title.
  let loadedDetailId: string | null = null;
  createEffect(() => {
    const sel = args.selected();
    if (!sel || args.initialDetail || sel.id === loadedDetailId) return;
    loadedDetailId = sel.id;
    const wantedId = sel.id;
    setDetail(null);
    setDetailLoading(true);
    void args.shell
      .readIssue(wantedId)
      .then((d) => {
        if (args.selected()?.id === wantedId) setDetail(d);
      })
      .catch(() => {
        if (args.selected()?.id === wantedId) setDetail(null);
      })
      .finally(() => {
        if (args.selected()?.id === wantedId) setDetailLoading(false);
      });
  });

  // Widths. Both panes are definite — list 40%, detail 60% — so content can't
  // push the split around; flexGrow absorbs only a column of rounding slack.
  const listPaneW = () => Math.max(0, Math.floor(dims().width * 0.4));
  const detailPaneW = () => Math.max(0, Math.floor(dims().width * 0.6));
  // The list rows sit in a scrollbox whose content is `ROW_SCROLLBOX_INSET`
  // columns narrower than the pane inner (measured empirically — same as the
  // tree rows, see treeInnerW below), so the list budgets 2 fewer than
  // "pane − border − padding" would suggest. A row budget that's even one char
  // too generous wraps the row to a second line.
  const listInnerW = () => Math.max(0, listPaneW() - ROW_SCROLLBOX_INSET);
  const detailInnerW = () => Math.max(0, detailPaneW() - 4);
  // The tree view spans the full width: both its lean tree pane and its detail
  // pane below use the whole column (issue 15). The tree rows sit in a
  // scrollbox whose content is `ROW_SCROLLBOX_INSET` columns narrower than the
  // pane inner — measured, like the list: at width 58 a 40-char child title is
  // the widest that fits on one line, exactly what `dims − 6` budgets.
  const treeInnerW = () => Math.max(0, dims().width - ROW_SCROLLBOX_INSET);
  const treeDetailInnerW = () => Math.max(0, dims().width - 4);
  // The detail pane's inner width — which split it sits in depends on the view.
  const detailInnerWFor = () => (args.view() === "tree" ? treeDetailInnerW() : detailInnerW());

  // The displayed state the detail pane paints — the whole read-only "zoom" view
  // of the selected Issue, fed to DetailContent as narrow props. A whole-category
  // selection swaps the issue record for its summary (no fetched body read); the
  // run-status line remounts on its own key (via runVersion) so a ~2s poll bump
  // doesn't recreate the markdown body; the rest of the content remounts on
  // detailKey.
  const detailContent = (): DetailContentProps | null => {
    const cat = args.selectedCategory();
    if (cat) {
      return {
        issue: null,
        category: cat,
        detail: null,
        loading: false,
        dispatch: args.dispatchState(),
        release: args.releaseState(),
        runVersion: args.runVersion(),
        pulse: args.pulse(),
        agentStatus: undefined,
        isResolved: args.resolvedFor,
        runFor: (root: string) => args.shell.runFor(root),
        innerW: detailInnerWFor(),
      };
    }
    const sel = args.selected();
    if (!sel) return null;
    return {
      issue: sel,
      category: null,
      detail: detail(),
      loading: detailLoading(),
      dispatch: args.dispatchState(),
      release: args.releaseState(),
      runVersion: args.runVersion(),
      pulse: args.pulse(),
      agentStatus: args.agentStatusOf(sel),
      isResolved: args.resolvedFor,
      runFor: (root: string) => args.shell.runFor(root),
      innerW: detailInnerWFor(),
    };
  };

  // Key for the detail pane's content. Includes the selection, whether the body
  // read has landed (L/P/E), the pane width (for header re-truncation), and the
  // dispatch/release feedback (so the pane remounts when either changes). The
  // run-controller pulse is deliberately NOT here — it bumps every ~2s poll, so
  // including it would remount the whole pane (markdown body included) on a
  // timer and the markdown visibly flickers; the run-status line remounts on
  // its own key instead (see DetailContent).
  // OpenTUI 0.5.1 does not repaint text or props in place, so the pane must
  // remount when the read lands or the loaded body would never appear (same
  // workaround as the list-row selection background and pulse). NOTE: the keyed
  // <Show>'s children must take the key as an argument (see DetailPane) — a
  // zero-arg arrow makes Solid return the same fn reference on every key change,
  // so the pane silently never remounts.
  const detailKey = createMemo(() => {
    // A whole-category selection remounts on its summary — the pane paints the
    // category facts in place of any body (collapsible-categories 01).
    const cat = args.selectedCategory();
    if (cat) {
      return `cat:${cat.root}|${cat.count}|${cat.open}|${cat.yourTurn}|${detailInnerWFor()}`;
    }
    const s = args.selected();
    if (!s) return null;
    const d = detail();
    const loaded = d && d.id === s.id;
    const ds = args.dispatchState();
    const dispatchPart =
      ds.status === "idle" ? "I" : ds.status === "running" ? "R" : ds.status === "ok" ? `ok:${ds.paneId}` : "E";
    const rs = args.releaseState();
    const releasePart = rs.status === "idle" ? "I" : rs.status === "running" ? "R" : rs.status === "ok" ? `ok:${rs.tabClosed ? 1 : 0}` : "E";
    return `${s.id}|${loaded ? "L" : detailLoading() ? "P" : "E"}|${detailInnerWFor()}|${dispatchPart}|${releasePart}`;
  });

  return { detail, setDetail, detailLoading, detailKey, detailContent, listInnerW, treeInnerW };
}