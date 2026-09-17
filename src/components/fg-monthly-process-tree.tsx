'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * 成品製程版本樹 (Process-version tree) for the FG Monthly traditional view.
 *
 * Each row in the table has a `processBomVersion` like
 *   `[V01-01HF][V01-02LM][V01-03TI][V01-04HT][V01-05HT][V01-06CH][V01-07EP]…`
 *
 * Rows are grouped by 鍛造母件 (forging_parent) and within each group sorted
 * by processBomVersion, so adjacent rows tend to share long prefixes. We
 * compare each row's step sequence with the row above (within the same
 * forging-parent group) and visualise:
 *
 *   - **Shared steps** → thin horizontal "trunk" segment (no text), so the
 *     eye reads them as continuation of the trunk above.
 *   - **First diverged step** → solid coloured box with a left "└─" elbow
 *     pointing up to the trunk, marking the fork.
 *   - **Subsequent steps after divergence** → solid coloured boxes (the
 *     branch's own path).
 *
 * The very first row in a group has no row above to share with, so every
 * step is rendered as a solid box (the "trunk" of that group).
 */

// Step boxes show a SHORT form like "1HF" instead of the full "V01-01HF"
// (the column's horizontal position already encodes the step number, so the
// "01" between is redundant; the "V" prefix is implied for every step).
// Full step text is preserved in the cell's title-tooltip on hover.
const STEP_W = 32;          // px per step box — fits short "7CD9" comfortably
const STEP_GAP = 1;         // gap between adjacent step boxes
export const TREE_COL_PADDING = 4;

/** "V01-03LM" → "1LM"; "V07-10PA" → "7PA"; "V01-09EP" → "1EP".
 *  Falls back to the original string if it doesn't match the expected
 *  V<digits>-<digits><letters> pattern. */
function shortStep(s: string): string {
  const m = /^V0*(\d+)-\d+([A-Za-z0-9]+)$/.exec(s);
  if (!m) return s;
  return `${m[1]}${m[2]}`;
}
/** Estimated rendered row height in px. Used to size the elbow connector
 *  vertically so it visually reaches the SOURCE row (the row that actually
 *  draws the previous shared step as a solid box). Empirically the
 *  traditional table renders rows at ~20-22 px; aggregated members are
 *  about the same. Slight under-estimate is fine — the elbow just needs
 *  to land near the source box, the trunk lines fill in the rest. */
const ROW_HEIGHT = 20;

/** Parse "[V01-01HF][V01-02LM]…" into ["V01-01HF", "V01-02LM", …]. */
export function parseProcessSteps(s: string | null | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

/** How many steps does the longest path in this group have. Used to size the column. */
export function maxStepDepth(items: { processBomVersion: string | null }[]): number {
  let max = 0;
  for (const it of items) {
    const n = parseProcessSteps(it.processBomVersion).length;
    if (n > max) max = n;
  }
  return max;
}

/** Width in px the tree column needs for a given max depth. */
export function treeColumnWidth(depth: number): number {
  if (depth <= 0) return 0;
  return TREE_COL_PADDING * 2 + depth * STEP_W + (depth - 1) * STEP_GAP;
}

/**
 * Render one row's process-version path. Compares against `prevSteps` (the
 * row above in the SAME forging-parent group; empty array for the first row
 * of a group) to compute the divergence index.
 *
 * The elbow connector is positioned to STOP just below the source row's
 * card (in the inter-row gap), never extending INTO the source card's box
 * area — that's what lets the source cards stay visually unobscured ("elbow
 * goes under the card"). For rows where the source is N rows back (e.g.
 * aggregated members all sharing the parent's prefix as trunk lines), the
 * elbow's vertical part stretches across the intermediate trunk rows but
 * still terminates before the actual source card.
 */
export function ProcessTreeCell({
  steps,
  prevSteps,
  isFirstInGroup,
  isLastInGroup,
  depth,
  rowsBackToSource = 1,
  sourceRowId,
  revision,
}: {
  steps: string[];
  prevSteps: string[];
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  /** The max depth across the whole visible page, so all cells line up. */
  depth: number;
  /** Fallback when DOM measurement isn't available — how many rows above
   *  is the source row in the items array. */
  rowsBackToSource?: number;
  /** data-row-id of the SOURCE row (the row drawing the previous shared
   *  step as a solid box). When present we measure the actual DOM distance
   *  from this cell to that row's TR after layout, so the elbow reaches
   *  the right place even when expanded aggregated members have inserted
   *  extra rows in between. */
  sourceRowId?: number | string | null;
  /** Bump this whenever DOM row counts change (e.g. an aggregated row was
   *  expanded/collapsed) so the layout-effect re-measures. */
  revision?: string | number;
}) {
  const elbowRef = useRef<HTMLSpanElement>(null);

  // Re-measure the actual DOM distance to the source row after every layout.
  // Walking N siblings back fails when expanded aggregated members add rows
  // we don't know about — so we look up the source row by its data-row-id
  // instead, which stays correct regardless of what's between us.
  useLayoutEffect(() => {
    const span = elbowRef.current;
    if (!span || sourceRowId == null) return;
    const tr = span.closest('tr') as HTMLElement | null;
    if (!tr) return;
    const sourceTr = span.closest('table')?.querySelector<HTMLElement>(
      `tr[data-row-id="${sourceRowId}"]`,
    );
    if (!sourceTr) return;
    const trRect = tr.getBoundingClientRect();
    const sourceRect = sourceTr.getBoundingClientRect();
    // Only adjust if the source is actually above us (defensive — if the
    // DOM order changes unexpectedly we just fall back to the static height).
    if (sourceRect.bottom > trRect.top) return;
    const sourceCardMid = Math.min(sourceRect.height, 22) / 2;
    const distance = trRect.top - sourceRect.bottom;
    const elbowH = Math.max(6, distance + sourceCardMid);
    span.style.top = `${-elbowH}px`;
    // +9 keeps the bottom-right of the L landing at THIS card's vertical
    // middle (card is 18px tall, so half = 9).
    span.style.height = `${elbowH + 9}px`;
  }, [sourceRowId, rowsBackToSource, depth, revision]);

  // Find first index where this row's step differs from the row above.
  // First row of a group is treated as "everything diverged" (entire path
  // is its own trunk).
  let divergeIdx = 0;
  if (!isFirstInGroup) {
    while (
      divergeIdx < steps.length &&
      divergeIdx < prevSteps.length &&
      steps[divergeIdx] === prevSteps[divergeIdx]
    ) {
      divergeIdx++;
    }
  } else {
    divergeIdx = 0;
  }

  // Pad to `depth` so cells line up across rows even when this part has
  // fewer steps than the deepest sibling.
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < depth; i++) {
    const step = steps[i];
    const isShared = !isFirstInGroup && i < divergeIdx;
    const isElbow = !isFirstInGroup && i === divergeIdx && step != null;
    const isOwnBranch = !isFirstInGroup && i > divergeIdx && step != null;
    const isFirstRowStep = isFirstInGroup && step != null;

    if (step == null) {
      // No step at this depth → empty placeholder to preserve alignment.
      cells.push(
        <div
          key={i}
          aria-hidden
          style={{ width: STEP_W, marginLeft: i === 0 ? 0 : STEP_GAP }}
        />,
      );
      continue;
    }

    if (isShared) {
      // Thin trunk segment (no text) — draws the visual "continuation
      // from the row above". The vertical line is the trunk, the
      // horizontal hairline is just enough to show the cell is alive.
      cells.push(
        <div
          key={i}
          className="relative flex items-center justify-center"
          style={{ width: STEP_W, marginLeft: i === 0 ? 0 : STEP_GAP, height: '100%' }}
          title={step}
        >
          <span
            className="bg-slate-300"
            style={{ width: 2, height: '100%', display: 'inline-block' }}
          />
        </div>,
      );
      continue;
    }

    // Solid step box — first-row trunk, elbow (fork point), or own-branch.
    const baseBg = isFirstRowStep
      ? 'bg-emerald-100 border-emerald-400 text-emerald-900'
      : isElbow
      ? 'bg-amber-100 border-amber-400 text-amber-900'
      : isOwnBranch
      ? 'bg-amber-50 border-amber-300 text-amber-800'
      : 'bg-slate-100 border-slate-300 text-slate-700';

    cells.push(
      <div
        key={i}
        className={`relative inline-flex items-center justify-center font-mono rounded border text-[9px] font-semibold ${baseBg}`}
        style={{
          width: STEP_W,
          marginLeft: i === 0 ? 0 : STEP_GAP,
          height: 18,
          letterSpacing: '-0.02em',
          // Critical so the elbow connector below can extend up into the row
          // above without being clipped by the cell's bounding box.
          overflow: 'visible',
        }}
        title={step}
      >
        {/* Elbow connector — L-shape pointing back to the SOURCE step
            column. Vertical part sits at the previous shared cell's
            centre x; height is sized so the elbow's TOP reaches just
            below the source card (in the inter-row gap N rows up) and
            never extends INTO the source card's body. That's what makes
            the source cards stay unobscured ("elbow under the card").
            For compact case (rowsBack=1) the elbow lives entirely in the
            single inter-row gap; for expanded members (rowsBack=N+1) it
            stretches across N intermediate trunk-line rows. */}
        {isElbow && (() => {
          // (rowsBack-1) full row heights up + a small gap at the top so
          // we stop just shy of the source card.
          const elbowH = Math.max(6, (rowsBackToSource - 1) * ROW_HEIGHT + 6);
          // Card is 18 px tall; we want the horizontal segment to terminate
          // at the vertical MIDDLE of this card's left edge (y = 9). So we
          // extend the span downward into the card's area by half the card
          // height — the bottom border lands exactly at the card's mid-line
          // and ends at x = 0 (the card's left edge).
          const dropIntoCard = 9;
          return (
            <span
              ref={elbowRef}
              aria-hidden
              className="absolute border-l-2 border-b-2 border-amber-500 rounded-bl pointer-events-none"
              style={{
                left: -(STEP_W / 2 + STEP_GAP),       // align with prev shared cell's centre
                width: STEP_W / 2 + STEP_GAP,         // end at THIS card's left edge
                top: -elbowH,                         // initial; useLayoutEffect overrides with measured value
                height: elbowH + dropIntoCard,        // initial; useLayoutEffect overrides
              }}
            />
          );
        })()}
        {shortStep(step)}
      </div>,
    );
  }

  return (
    <div
      className="flex items-center"
      style={{
        paddingLeft: TREE_COL_PADDING,
        paddingRight: TREE_COL_PADDING,
        minHeight: 22,
      }}
    >
      {cells}
      {/* Hide-marker so the next row knows where this one ends — currently
          unused, kept for future enhancement (e.g. drawing trunk-stop tick). */}
      {isLastInGroup && <span aria-hidden style={{ width: 0 }} />}
    </div>
  );
}
