/**
 * The reading stage: geometry, playhead and the bar highlight.
 *
 * The whole test renders in normal page flow — no fullscreen, no cropped
 * follow-window — so the reader can see the entire piece and just scrolls the
 * page like any other document. During playback the current bar is tinted
 * and a moving playhead sweeps across it; when playback moves to a new
 * system, that system is scrolled into view.
 *
 * Geometry comes from the rendered SVG rather than OSMD's graphic model:
 * every bar is a `g.vf-measure` whose id is its bar number, and it appears
 * once per staff, so the union of both is the bar's full height.
 */

export function createStage(elements) {
  const { score, playline, highlight } = elements;

  /** @type {{bars: Map<number, object>, systems: object[], scale: number}} */
  let layout = { bars: new Map(), systems: [], scale: 1, origin: { x: 0, y: 0 } };
  let active = false;
  let currentSystem = -1;

  /** Read bar and system boxes out of the rendered SVG. */
  function measure() {
    const svg = score.querySelector('svg');
    layout = { bars: new Map(), systems: [], scale: 1, origin: { x: 0, y: 0 } };
    if (!svg) return layout;

    // getBBox is in SVG user units; the element may be laid out at another size.
    const viewBox = svg.viewBox?.baseVal;
    const rect = svg.getBoundingClientRect();
    const scale = viewBox?.width ? rect.width / viewBox.width : 1;

    const boxes = new Map();
    const contentLefts = new Map();
    for (const element of svg.querySelectorAll('g.vf-measure')) {
      const number = Number(element.id);
      if (!Number.isFinite(number)) continue;
      const box = element.getBBox();
      const existing = boxes.get(number);
      boxes.set(number, existing ? union(existing, box) : toRect(box));

      /*
       * A bar's own box starts at the stave lines, which run under whatever
       * comes before its notes too — the clef, key and time signature that
       * VexFlow draws inside bar 1 of every system. The playhead and the
       * highlight block both need to start at the first actual note, not at
       * that leading furniture, or on every system's opening bar they
       * visibly start from the clef instead of beat one.
       */
      const noteLefts = [...element.children]
        .filter((child) => child.getAttribute('class') === 'vf-stavenote')
        .map((child) => child.getBBox().x);
      if (noteLefts.length) {
        const contentLeft = Math.min(...noteLefts);
        contentLefts.set(number, Math.min(contentLefts.get(number) ?? Infinity, contentLeft));
      }
    }
    if (!boxes.size) return layout;
    for (const [number, box] of boxes) box.contentLeft = contentLefts.get(number) ?? box.left;

    // Cluster bars into systems by vertical position.
    const ordered = [...boxes.entries()].sort((a, b) => a[1].top - b[1].top || a[1].left - b[1].left);
    const systems = [];
    for (const [number, box] of ordered) {
      const last = systems[systems.length - 1];
      const sameRow = last && box.top < last.bottom - (box.bottom - box.top) * 0.4;
      if (sameRow) {
        last.bars.push(number);
        last.top = Math.min(last.top, box.top);
        last.bottom = Math.max(last.bottom, box.bottom);
        last.left = Math.min(last.left, box.left);
        last.right = Math.max(last.right, box.right);
      } else {
        systems.push({ bars: [number], ...box });
      }
    }

    systems.forEach((system, index) => {
      for (const number of system.bars) boxes.get(number).system = index;
    });

    /*
     * A bar's box covers its notes, but slurs, hairpins and dynamics are drawn
     * outside it and can hang well below the staff. Grow each system to cover
     * every staff group it overlaps, or the highlight clips those.
     */
    for (const staffline of svg.querySelectorAll('g.staffline')) {
      const box = toRect(staffline.getBBox());
      const middle = (box.top + box.bottom) / 2;
      const system = systems.find((candidate) => middle >= candidate.top && middle <= candidate.bottom)
        ?? systems.find((candidate) => box.top < candidate.bottom && box.bottom > candidate.top);
      if (!system) continue;
      system.top = Math.min(system.top, box.top);
      system.bottom = Math.max(system.bottom, box.bottom);
    }

    /*
     * Where the SVG's own origin sits inside the box the highlight and the
     * playhead are positioned against.
     *
     * Both are absolutely positioned siblings of `#score`, so their `top`/
     * `left` are measured from `.score-frame`'s padding box — but the numbers
     * fed to them come from `getBBox`, which is measured from the *SVG's*
     * origin. Those two origins are not the same point: the frame carries its
     * own padding (room for the grade selector and countdown pinned to its
     * corners), and `#score` carries the padding `pinScoreTop` adds to hold
     * the staff at a fixed height. Ignoring the difference put the highlight
     * 78px above the bar it was meant to be tinting, with the block's lower
     * edge cutting through the middle of the bass stave.
     *
     * `clientLeft`/`clientTop` are the frame's border widths, since an
     * absolutely positioned offset starts at the padding box rather than the
     * border box.
     */
    const frame = highlight.offsetParent ?? score.parentElement;
    let origin = { x: 0, y: 0 };
    if (frame) {
      const frameRect = frame.getBoundingClientRect();
      origin = {
        x: rect.left - (frameRect.left + frame.clientLeft),
        y: rect.top - (frameRect.top + frame.clientTop),
      };
    }

    layout = { bars: boxes, systems, scale, origin };
    return layout;
  }

  function begin() {
    if (!layout.systems.length) return false;
    active = true;
    currentSystem = -1;
    playline.style.display = 'block';
    highlight.style.display = 'block';
    return true;
  }

  function end() {
    active = false;
    currentSystem = -1;
    playline.style.display = '';
    highlight.style.display = '';
  }

  /**
   * @param {number} bar 1-based bar number
   * @param {number} progress 0–1 through that bar
   */
  function update(bar, progress) {
    if (!active) return;
    const box = layout.bars.get(bar);
    if (!box) return;
    const { scale, origin } = layout;
    const system = layout.systems[box.system];

    if (box.system !== currentSystem) {
      currentSystem = box.system;
      // Bring the new line into view; the reader scrolls the page normally
      // otherwise, so this only has to fire on a line change, not every frame.
      highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const left = origin.x + box.contentLeft * scale;
    const width = (box.right - box.contentLeft) * scale;
    const top = origin.y + system.top * scale;
    const height = (system.bottom - system.top) * scale;

    highlight.style.left = `${left}px`;
    highlight.style.width = `${width}px`;
    highlight.style.top = `${top}px`;
    highlight.style.height = `${height}px`;

    const x = left + width * Math.min(Math.max(progress, 0), 1);
    playline.style.transform = `translateX(${x}px)`;
    playline.style.top = `${top}px`;
    playline.style.height = `${height}px`;
  }

  return {
    measure,
    begin,
    end,
    update,
    get active() { return active; },
    get systems() { return layout.systems.length; },
  };
}

/**
 * Where each bar starts and ends, in seconds from the first note.
 * Every bar lasts the same time — the generator never changes metre mid-test.
 */
export function barTimings(score) {
  const secondsPerBar = (60 / score.tempoBpm) * (score.barDuration / score.divisions);
  return { secondsPerBar, total: secondsPerBar * score.barCount };
}

function toRect(box) {
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

function union(rect, box) {
  return {
    left: Math.min(rect.left, box.x),
    right: Math.max(rect.right, box.x + box.width),
    top: Math.min(rect.top, box.y),
    bottom: Math.max(rect.bottom, box.y + box.height),
  };
}
