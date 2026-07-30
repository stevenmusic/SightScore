/**
 * The reading stage: geometry, playhead and the two-row follow view.
 *
 * ScrollScore scrolls one long row sideways under a fixed playline. A sight-
 * reading test is read differently — you need the next line in view before you
 * reach it — so this keeps two systems on screen: playing system 1 shows
 * systems 1 and 2, playing system 2 shows 2 and 3. The playhead and the
 * current-bar colour block are ScrollScore's, moved onto that layout.
 *
 * Geometry comes from the rendered SVG rather than OSMD's graphic model:
 * every bar is a `g.vf-measure` whose id is its bar number, and it appears
 * once per staff, so the union of both is the bar's full height.
 */

/** Breathing room under the lower system so descending stems stay whole. */
const BOTTOM_ALLOWANCE = 10;
/**
 * Room above a system for text that sits over it — the tempo word, rehearsal
 * numbers. Bar boxes do not include those, so scrolling to a bar's own top
 * cut "Lento" in half.
 */
const TEXT_ALLOWANCE = 30;
/** Distance from the top of the window to that allowance. */
const TOP_INSET = 8;

export function createStage(elements) {
  const { frame, stage, scroller, score, playline, highlight, fullscreen } = elements;

  /** @type {{bars: Map<number, object>, systems: object[], scale: number}} */
  let layout = { bars: new Map(), systems: [], scale: 1 };
  let following = false;
  let currentSystem = -1;

  /** Read bar and system boxes out of the rendered SVG. */
  function measure() {
    const svg = score.querySelector('svg');
    layout = { bars: new Map(), systems: [], scale: 1 };
    if (!svg) return layout;

    // getBBox is in SVG user units; the element may be laid out at another size.
    const viewBox = svg.viewBox?.baseVal;
    const rect = svg.getBoundingClientRect();
    const scale = viewBox?.width ? rect.width / viewBox.width : 1;

    const boxes = new Map();
    for (const element of svg.querySelectorAll('g.vf-measure')) {
      const number = Number(element.id);
      if (!Number.isFinite(number)) continue;
      const box = element.getBBox();
      const existing = boxes.get(number);
      boxes.set(number, existing ? union(existing, box) : toRect(box));
    }
    if (!boxes.size) return layout;

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
     * every staff group it overlaps, or the window clips those.
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

    layout = { bars: boxes, systems, scale };
    return layout;
  }

  /**
   * Height of the window showing system `index` and the one after it, from the
   * top of the first to the bottom of the second.
   *
   * Sizing to the tallest pair in the piece instead leaves slack on shorter
   * pairs, and the system after next then peeks in at the bottom edge, which
   * reads exactly like a row with its stems cut off.
   */
  function windowHeight(index = 0) {
    const { systems, scale } = layout;
    if (!systems.length) return 0;
    const first = systems[Math.min(index, systems.length - 1)];
    const second = systems[index + 1];
    const span = second ? second.bottom - first.top : first.bottom - first.top;
    return span * scale + BOTTOM_ALLOWANCE + TEXT_ALLOWANCE + TOP_INSET;
  }

  function begin() {
    measure();
    if (!layout.systems.length) return false;
    following = true;
    currentSystem = -1;
    stage.classList.add('following');
    stage.style.height = `${windowHeight(0)}px`;
    playline.style.display = 'block';
    highlight.style.display = 'block';
    return true;
  }

  function end() {
    following = false;
    currentSystem = -1;
    stage.classList.remove('following');
    stage.style.height = '';
    scroller.style.transform = '';
    playline.style.display = '';
    highlight.style.display = '';
  }

  /**
   * @param {number} bar 1-based bar number
   * @param {number} progress 0–1 through that bar
   */
  function update(bar, progress) {
    if (!following) return;
    const box = layout.bars.get(bar);
    if (!box) return;
    const { scale } = layout;
    const system = layout.systems[box.system];

    if (box.system !== currentSystem) {
      currentSystem = box.system;
      // Put the current system at the top; the next one sits below it, and the
      // window is resized to that exact pair so nothing else shows through.
      scroller.style.transform = `translateY(${-system.top * scale + TOP_INSET + TEXT_ALLOWANCE}px)`;
      stage.style.height = `${windowHeight(box.system)}px`;
    }

    const left = box.left * scale;
    const width = (box.right - box.left) * scale;
    const top = system.top * scale;
    const height = (system.bottom - system.top) * scale;

    highlight.style.left = `${left}px`;
    highlight.style.width = `${width}px`;
    highlight.style.top = `${top}px`;
    highlight.style.height = `${height}px`;

    const x = left + width * Math.min(Math.max(progress, 0), 1);
    playline.style.transform = `translateX(${x}px) translateY(${top - system.top * scale + TOP_INSET + TEXT_ALLOWANCE}px)`;
    playline.style.height = `${height}px`;

    /*
     * On a narrow screen the system is wider than the frame, so the playhead
     * marches off the right edge and the music never follows it. Scroll the
     * frame so the playhead stays about a third of the way in, which keeps
     * what is coming next on screen.
     */
    const visible = frame.clientWidth;
    if (frame.scrollWidth > visible + 1) {
      const target = Math.max(0, Math.min(x - visible * 0.34, frame.scrollWidth - visible));
      // Only nudge when it has drifted, so a manual scroll is not fought over.
      if (Math.abs(frame.scrollLeft - target) > 2) frame.scrollLeft = target;
    }
  }

  /*
   * iOS Safari does not implement Element.requestFullscreen — only <video>
   * can go fullscreen there — so the button did nothing at all on iPhone and
   * iPad. Fall back to filling the viewport with CSS, which works everywhere
   * and looks the same to the reader.
   */
  let pseudoFullscreen = false;

  function applyFullscreenState(active, pseudo) {
    frame.classList.toggle('is-fullscreen', active);
    frame.classList.toggle('is-pseudo-fullscreen', active && pseudo);
    document.body.classList.toggle('has-fullscreen-frame', active && pseudo);
    fullscreen.setAttribute('aria-label', active ? '離開全螢幕' : '全螢幕');
    fullscreen.title = active ? '離開全螢幕' : '全螢幕檢視整首樂譜';
    elements.onFullscreenChange?.(active);
  }

  function enterPseudoFullscreen() {
    pseudoFullscreen = true;
    applyFullscreenState(true, true);
  }

  function exitPseudoFullscreen() {
    pseudoFullscreen = false;
    applyFullscreenState(false, true);
  }

  async function toggleFullscreen() {
    if (pseudoFullscreen) {
      exitPseudoFullscreen();
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (typeof frame.requestFullscreen === 'function') {
      try {
        await frame.requestFullscreen({ navigationUI: 'hide' });
        return;
      } catch {
        // Refused (a user-gesture rule, an iframe policy): fall through.
      }
    }
    enterPseudoFullscreen();
  }

  document.addEventListener('fullscreenchange', () => {
    if (pseudoFullscreen) return;
    applyFullscreenState(document.fullscreenElement === frame, false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pseudoFullscreen) exitPseudoFullscreen();
  });

  fullscreen.addEventListener('click', () => {
    toggleFullscreen().catch(() => {
      /* nothing further to try */
    });
  });

  return {
    measure,
    begin,
    end,
    update,
    get following() { return following; },
    get systems() { return layout.systems.length; },
    get isFullscreen() { return pseudoFullscreen || document.fullscreenElement === frame; },
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
