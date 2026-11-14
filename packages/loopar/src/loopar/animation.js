export const reverses = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
  up: "down",
  down: "up",
  in: "out",
  out: "in",
}

export const animations = (notContains) => {
  const animations = {
    "random": {
      
    },
    "fade-up": {
      initial: "opacity-0 translate-y-4",
      visible: "opacity-100 translate-y-0",
    },
    "fade-down": {
      initial: "opacity-0 -translate-y-4",
      visible: "opacity-100 translate-y-0",
    },
    "fade-left": {
      initial: "opacity-0 translate-x-4",
      visible: "opacity-100 translate-x-0",
    },
    "fade-right": {
      initial: "opacity-0 -translate-x-4",
      visible: "opacity-100 translate-x-0",
    },
    "slide-up": {
      initial: "opacity-0 translate-y-4",
      visible: "opacity-100 translate-y-0",
    },
    "slide-down": {
      initial: "opacity-0 -translate-y-4",
      visible: "opacity-100 translate-y-0",
    },
    "slide-left": {
      initial: "opacity-0 translate-x-4",
      visible: "opacity-100 translate-x-0",
    },
    "slide-right": {
      initial: "opacity-0 -translate-x-4",
      visible: "opacity-100 translate-x-0",
    },
    // Motion only, no fade: for covers and backgrounds, where a fade would
    // flash whatever is behind them.
    "drift-left": {
      initial: "translate-x-10",
      visible: "translate-x-0",
    },
    "drift-right": {
      initial: "-translate-x-10",
      visible: "translate-x-0",
    },
    "zoom-in": {
      initial: "opacity-0 scale-95",
      visible: "opacity-100 scale-100",
    },
    "zoom-out": {
      initial: "opacity-0 scale-105",
      visible: "opacity-100 scale-100",
    },
    "flip-up": {
      initial: "opacity-0 rotateX-90",
      visible: "opacity-100 rotateX-0",
    },
    "flip-down": {
      initial: "opacity-0 rotateX--90",
      visible: "opacity-100 rotateX-0",
    }
  }

  if (notContains) {
    return Object.keys(animations)
      .filter((a) => !a.includes(notContains))
      .reduce((obj, key) => {
        obj[key] = animations[key];
        return obj;
      }, {}); //.map(a => ({value: a, label: animations[a]}));
  }

  return animations;
}

export const reverseAnimation = (animation) => {
  return !animation
    ? null
    : animation
        .split("-")
        .map((a) => reverses[a] || a)
        .join("-");
}

export const getAnimation = (animation, notContains) => {
  if (!animation) return null;
  if (animation === "random") {
    const transitions = Object.keys(animations(notContains)).filter(
      // Motion-only animations are a deliberate choice, never a random pick.
      (animation) => animation !== "random" && !animation.startsWith("drift-")
    );
    return animations()[transitions[Math.floor(Math.random() * transitions.length)]]
  } else {
    return animations()[animation];
  }
}

const animation = {
  animations,
  reverseAnimation,
  getAnimation,
}

export default animation;