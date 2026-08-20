---
"herdr-frontier": minor
---

Categories and dependency-tree nodes now fold/unfold. In the list view, `Enter`/`Space` on a selected category — or a click on its header — folds it: issue rows hide, the header keeps its full count, the chevron flips `▾`/`▸`, and the cursor clamps onto the header so it never rests on a hidden issue. In the dependency tree, `Space` on a node folds its whole subtree (a leaf's `Space` is a no-op; `Enter` still dispatches), with the same live chevron before the connector. Fold state is session-only in both views — keyed per effort name in the list, per issue id in the tree — so reloads and the ~2s poll keep your arrangement and only a restart resets it.