import { useEffect, useMemo, useRef, useState } from "react";

// tsparticles (~40 kB br) is decorative and client-only: the server never renders
// the canvas, so it is loaded on demand when the element comes near the viewport.
// SSR and the hydration render paint the same empty container.
//
// @tsparticles/react v4: the engine is initialised once per app through
// <ParticlesProvider init>, whose `init` callback MUST be a stable reference
// (the provider throws if it changes between renders) — it lives in the cached
// runtime below. Children render only after the engine is loaded.
let runtime = null;
const loadRuntime = () => (runtime ??= Promise.all([
  import("@tsparticles/react"),
  import("@tsparticles/slim"),
]).then(([react, slim]) => ({
  Particles: react.default,
  ParticlesProvider: react.ParticlesProvider,
  init: (engine) => slim.loadSlim(engine),
})));

function useParticlesRuntime(ref) {
  const [rt, setRt] = useState(null);

  useEffect(() => {
    let alive = true;
    const start = () => loadRuntime().then((r) => alive && setRt(r));

    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      start();
      return () => { alive = false; };
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        start();
      }
    }, { rootMargin: "200px" });
    observer.observe(el);

    return () => { alive = false; observer.disconnect(); };
  }, [ref]);

  return rt;
}

export function ParticlesMaster({ options = {}, ...props }) {
  const ref = useRef(null);
  const rt = useParticlesRuntime(ref);

  const particlesOptions = useMemo(() => ({
    fullScreen: { enable: props.fullScreen ?? false },
    ...options,
    detectRetina: true,
  }), [options, props.fullScreen]);

  return (
    <div ref={ref} className="w-full h-full absolute inset-0 z-0">
      {rt && (
        <rt.ParticlesProvider init={rt.init}>
          <rt.Particles
            id={props.id}
            className="w-full h-full absolute inset-0 z-0"
            options={particlesOptions}
          />
        </rt.ParticlesProvider>
      )}
    </div>
  );
}
