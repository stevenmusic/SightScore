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

const SYSTEM_GAP = 16;

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

    layout = { bars: boxes, systems, scale };
    return layout;
  }

  /** Height of the tallest pair of adjacent systems, so the frame never jumps. */
  function windowHeight() {
    const { systems, scale } = layout;
    if (!systems.length) return 0;
    let tallest = 0;
    for (let i = 0; i < systems.length; i++) {
      const first = systems[i].bottom - systems[i].top;
      const second = systems[i + 1] ? systems[i + 1].bottom - systems[i + 1].top : 0;
      tallest = Math.max(tallest, second ? first + SYSTEM_GAP + second : first);
    }
    return tallest * scale;
  }

  function begin() {
    measure();
    if (!layout.systems.length) return false;
    following = true;
    currentSystem = -1;
    stage.classList.add('following');
    stage.style.height = `${windowHeight() + 24}px`;
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
      // Put the current system at the top; the next one sits below it.
      scroller.style.transform = `translateY(${-system.top * scale + 12}px)`;
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
    playline.style.transform = `translateX(${x}px) translateY(${top - system.top * scale + 12}px)`;
    playline.style.height = `${height}px`;
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (frame.requestFullscreen) {
      await frame.requestFullscreen({ navigationUI: 'hide' });
    }
  }

  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === frame;
    frame.classList.toggle('is-fullscreen', active);
    fullscreen.setAttribute('aria-label', active ? '離開全螢幕' : '全螢幕');
    fullscreen.title = active ? '離開全螢幕' : '全螢幕檢視整首樂譜';
    elements.onFullscreenChange?.(active);
  });

  fullscreen.addEventListener('click', () => {
    toggleFullscreen().catch(() => {
      /* the browser refused; nothing else to do */
    });
  });

  return {
    measure,
    begin,
    end,
    update,
    get following() { return following; },
    get systems() { return layout.systems.length; },
    get isFullscreen() { return document.fullscreenElement === frame; },
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
